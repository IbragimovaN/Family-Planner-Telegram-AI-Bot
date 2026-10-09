import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sessionFrom } from "./auth/routes.js";
import { FamilyError, findFamily } from "./family.js";

const title = z.string().trim().min(1).max(200);
const createSchema = z.object({ title }).strict();
const patchSchema = z.object({ title: title.optional(), bought: z.boolean().optional() }).strict().refine(body => Object.keys(body).length > 0);
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new FamilyError(400, "Проверьте название покупки.");
  return result.data;
}

export function createPurchasesRouter(db: Database.Database) {
  const router = Router();
  function familyId(user: string) {
    const family = findFamily(db, user);
    if (!family) throw new FamilyError(403, "Сначала создайте семью или вступите по приглашению.");
    return family.id;
  }
  const atomic = (handler: RequestHandler): RequestHandler => (request, response, next) => {
    db.transaction(() => handler(request, response, next)).immediate();
  };
  router.get("/purchases", (_request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    const items = db.prepare("SELECT id,title,bought FROM purchases WHERE family_id=? ORDER BY created_at,rowid").all(family) as { id: string; title: string; bought: number }[];
    response.json({ list: { id: family, closedAt: null, closedByName: null, itemCount: items.length }, items: items.map(item => ({ ...item, bought: Boolean(item.bought) })) });
  });
  router.post("/purchases", atomic((request, response) => {
    const user = sessionFrom(response).user.id;
    const family = familyId(user);
    const body = parse(createSchema, request.body);
    const id = randomUUID();
    db.prepare("INSERT INTO purchases(id,family_id,title,created_by_user_id) VALUES (?,?,?,?)").run(id, family, body.title, user);
    response.status(201).json({ id });
  }));
  router.patch("/purchases/:id", atomic((request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    const id = parse(z.string().uuid(), request.params.id);
    const body = parse(patchSchema, request.body);
    const result = db.prepare("UPDATE purchases SET title=COALESCE(?,title),bought=COALESCE(?,bought),updated_at=unixepoch() WHERE family_id=? AND id=?")
      .run(body.title ?? null, body.bought === undefined ? null : Number(body.bought), family, id);
    if (!result.changes) throw new FamilyError(404, "Покупка не найдена.");
    response.status(204).end();
  }));
  router.delete("/purchases/:id", atomic((request, response) => {
    const family = familyId(sessionFrom(response).user.id);
    const id = parse(z.string().uuid(), request.params.id);
    parse(z.object({}).strict(), request.body);
    const result = db.prepare("DELETE FROM purchases WHERE family_id=? AND id=?").run(family, id);
    if (!result.changes) throw new FamilyError(404, "Покупка не найдена.");
    response.status(204).end();
  }));
  return router;
}
