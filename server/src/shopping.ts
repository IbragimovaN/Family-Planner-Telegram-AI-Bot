import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sessionFrom } from "./auth/routes.js";
import { FamilyError, findFamily } from "./family.js";

const idSchema = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).nullable().transform(value => value || null);
const fields = { title: z.string().trim().min(1).max(200), quantity: optionalText(100), note: optionalText(2000) };
const createSchema = z.object({ listId: idSchema, title: fields.title, quantity: fields.quantity.optional(), note: fields.note.optional() }).strict();
const updateSchema = z.object({ title: fields.title.optional(), quantity: fields.quantity.optional(), note: fields.note.optional(), bought: z.boolean().optional() })
  .strict().refine(value => Object.keys(value).length > 0);
const closeSchema = z.object({ listId: idSchema }).strict();
const emptySchema = z.object({}).strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new FamilyError(400, "Проверьте название, количество и заметку покупки.");
  return result.data;
}
type List = { id: string; createdAt: number; closedAt: number | null; closedByUserId: string | null; closedByName: string | null; itemCount: number };
type Item = { id: string; title: string; quantity: string | null; note: string | null; bought: number; createdAt: number };
const listSelect = `SELECT l.id, l.created_at AS createdAt, l.closed_at AS closedAt,
  l.closed_by_user_id AS closedByUserId, u.first_name AS closedByName,
  (SELECT count(*) FROM shopping_items i WHERE i.list_id=l.id AND i.family_id=l.family_id) AS itemCount
  FROM shopping_lists l LEFT JOIN users u ON u.id=l.closed_by_user_id`;

export function createShoppingRouter(db: Database.Database) {
  const router = Router();
  const atomic = (handler: RequestHandler): RequestHandler => (request, response, next) => {
    db.transaction(() => handler(request, response, next)).immediate();
  };
  function familyId(userId: string) {
    const family = findFamily(db, userId);
    if (!family) throw new FamilyError(403, "Сначала создайте семью или вступите по приглашению.");
    return family.id;
  }
  function list(family: string, id?: string) {
    const result = db.prepare(`${listSelect} WHERE l.family_id=? AND ${id ? "l.id=?" : "l.closed_at IS NULL"}`)
      .get(...(id ? [family, id] : [family])) as List | undefined;
    if (!result) throw new FamilyError(404, "Список не найден. Обновите страницу.");
    return result;
  }
  function editable(family: string, id: string) {
    const result = list(family, id);
    if (result.closedAt !== null) throw new FamilyError(409, "Этот список уже закрыт. Откройте текущий список.");
    return result;
  }
  function details(family: string, target: List) {
    const items = db.prepare(`SELECT id,title,quantity,note,bought,created_at AS createdAt FROM shopping_items
      WHERE family_id=? AND list_id=? ORDER BY bought,created_at,id`).all(family, target.id) as Item[];
    return { list: target, items: items.map(item => ({ ...item, bought: Boolean(item.bought) })) };
  }
  function itemList(family: string, id: string) {
    const item = db.prepare("SELECT list_id FROM shopping_items WHERE family_id=? AND id=?").get(family, id) as { list_id: string } | undefined;
    if (!item) throw new FamilyError(404, "Покупка не найдена. Возможно, её удалил другой участник.");
    editable(family, item.list_id);
    return item.list_id;
  }

  router.get("/shopping-lists/current", (_request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    response.json(details(family, list(family)));
  });
  router.get("/shopping-lists/history", (_request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    response.json({ lists: db.prepare(`${listSelect} WHERE l.family_id=? AND l.closed_at IS NOT NULL ORDER BY l.closed_at DESC,l.created_at DESC,l.rowid DESC`).all(family) });
  });
  router.get("/shopping-lists/:id", (request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    response.json(details(family, list(family, parse(idSchema, request.params.id))));
  });
  router.post("/shopping-lists/current/items", atomic((request, response) => {
    const user = sessionFrom(response).user.id;
    const family = familyId(user);
    const body = parse(createSchema, request.body);
    editable(family, body.listId);
    const id = randomUUID();
    db.prepare("INSERT INTO shopping_items (id,family_id,list_id,title,quantity,note,created_by_user_id) VALUES (?,?,?,?,?,?,?)")
      .run(id, family, body.listId, body.title, body.quantity ?? null, body.note ?? null, user);
    response.status(201).json({ id });
  }));
  router.patch("/shopping-items/:id", atomic((request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    const id = parse(idSchema, request.params.id);
    const body = parse(updateSchema, request.body);
    itemList(family, id);
    // Fixed column names; only explicitly supplied fields change.
    const columns = ["title", "quantity", "note", "bought"] as const;
    const supplied = columns.filter(key => body[key] !== undefined);
    const values = supplied.map(key => key === "bought" ? Number(body[key]) : body[key] as string | null);
    db.prepare(`UPDATE shopping_items SET ${supplied.map(key => `${key}=?`).join(",")},updated_at=unixepoch() WHERE family_id=? AND id=?`)
      .run(...values, family, id);
    response.status(204).end();
  }));
  router.delete("/shopping-items/:id", atomic((request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    parse(emptySchema, request.body);
    const id = parse(idSchema, request.params.id);
    itemList(family, id);
    db.prepare("DELETE FROM shopping_items WHERE family_id=? AND id=?").run(family, id);
    response.status(204).end();
  }));
  router.post("/shopping-lists/current/close", atomic((request, response) => {
    const user = sessionFrom(response).user.id;
    const family = familyId(user);
    const { listId } = parse(closeSchema, request.body);
    const target = list(family, listId);
    // A retried/concurrent close of this ID must never close its replacement.
    if (target.closedAt === null) {
      db.prepare("UPDATE shopping_lists SET closed_at=unixepoch(),closed_by_user_id=? WHERE family_id=? AND id=?").run(user, family, listId);
      db.prepare("INSERT INTO shopping_lists (id,family_id) VALUES (?,?)").run(randomUUID(), family);
    }
    response.json(details(family, list(family)));
  }));
  router.delete("/shopping-lists/:id", atomic((request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    parse(emptySchema, request.body);
    const id = parse(idSchema, request.params.id);
    if (list(family, id).closedAt === null) throw new FamilyError(409, "Можно удалить только закрытый список.");
    db.prepare("DELETE FROM shopping_lists WHERE family_id=? AND id=?").run(family, id);
    response.status(204).end();
  }));
  return router;
}
