import { createHash, randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sessionFrom } from "./auth/routes.js";
import { FamilyError, findFamily } from "./family.js";
import { classificationSchema, classifyShopping, type Classifier } from "./shopping-ai.js";

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

export function createShoppingRouter(db: Database.Database, classify: Classifier = classifyShopping) {
  const router = Router();
  const sorting = new Set<string>();
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
      WHERE family_id=? AND list_id=? ORDER BY sort_position,rowid`).all(family, target.id) as Item[];
    return { list: target, sortingRevision: target.closedAt === null ? revision(family, target.id) : null, items: items.map(item => ({ ...item, bought: Boolean(item.bought) })) };
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
  function sortingItems(family: string, listId: string) {
    return db.prepare("SELECT id,title,category_rank FROM shopping_items WHERE family_id=? AND list_id=? ORDER BY sort_position,rowid")
      .all(family, listId) as { id: string; title: string; category_rank: number | null }[];
  }
  function revision(family: string, listId: string) {
    const items = sortingItems(family, listId);
    return items.length > 1 && items.some(item => item.category_rank === null)
      ? createHash("sha256").update(JSON.stringify(items)).digest("hex") : null;
  }
  router.post("/shopping-lists/current/items", atomic((request, response) => {
    const user = sessionFrom(response).user.id;
    const family = familyId(user);
    const body = parse(createSchema, request.body);
    editable(family, body.listId);
    const id = randomUUID();
    const position = (db.prepare("SELECT COALESCE(MAX(sort_position),0)+1 AS n FROM shopping_items WHERE family_id=? AND list_id=?").get(family, body.listId) as { n: number }).n;
    db.prepare("INSERT INTO shopping_items (id,family_id,list_id,title,quantity,note,created_by_user_id,sort_position) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, family, body.listId, body.title, body.quantity ?? null, body.note ?? null, user, position);
    response.status(201).json({ id, sorting: "pending" });
  }));
  router.post("/shopping-lists/current/sort", async (request, response) => {
    const user = sessionFrom(response).user.id;
    const family = familyId(user);
    const { listId } = parse(closeSchema, request.body);
    editable(family, listId);
    if (sorting.has(listId)) { response.json({ sorting: "deferred" }); return; }
    const before = revision(family, listId);
    if (!before) { response.json({ sorting: "skipped" }); return; }
    const inputs = sortingItems(family, listId).filter(item => item.category_rank === null).map(({ id, title }) => ({ id, title }));
    sorting.add(listId);
    try {
      let classified: ReturnType<typeof classificationSchema.parse>;
      try {
        classified = classificationSchema.parse({ items: await classify(inputs) });
        const ids = new Set(classified.items.map(item => item.id));
        if (ids.size !== inputs.length || classified.items.length !== inputs.length || inputs.some(item => !ids.has(item.id))) throw new Error("Invalid classification IDs");
      } catch {
        if (!response.destroyed) response.json({ sorting: "unavailable" });
        return;
      }
      // A cancelled request must not reorder the list after the user resumes typing.
      if (response.destroyed) return;
      const applied = db.transaction(() => {
        if (familyId(user) !== family) throw new FamilyError(403, "Семья изменилась. Обновите список.");
        editable(family, listId);
        // New/edited/deleted items invalidate this answer. Keep insertion order until the next idle sort.
        if (revision(family, listId) !== before) return false;
        for (const item of classified.items) db.prepare("UPDATE shopping_items SET category_rank=? WHERE family_id=? AND list_id=? AND id=?")
          .run(item.category, family, listId, item.id);
        const sorted = db.prepare("SELECT id FROM shopping_items WHERE family_id=? AND list_id=? ORDER BY COALESCE(category_rank,14),sort_position,rowid").all(family, listId) as { id: string }[];
        sorted.forEach((item, index) => db.prepare("UPDATE shopping_items SET sort_position=? WHERE family_id=? AND list_id=? AND id=?").run(index + 1, family, listId, item.id));
        return true;
      }).immediate();
      response.json({ sorting: applied ? "applied" : "deferred" });
    } finally { sorting.delete(listId); }
  });
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
    if (body.title !== undefined) db.prepare("UPDATE shopping_items SET category_rank=NULL WHERE family_id=? AND id=?").run(family, id);
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
