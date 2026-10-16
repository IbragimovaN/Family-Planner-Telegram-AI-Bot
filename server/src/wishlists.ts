import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sessionFrom } from "./auth/routes.js";
import { FamilyError, findFamily } from "./family.js";

const idSchema = z.string().uuid();
const nameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const emptySchema = z.object({}).strict();
const nullableText = (max: number) => z.string().trim().max(max).nullable().transform(value => value || null);
const urlSchema = nullableText(2048).refine(value => {
  if (value === null) return true;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "Укажите ссылку с https:// или http://.");
const itemFields = {
  title: z.string().trim().min(1).max(200),
  url: urlSchema.optional(),
  note: nullableText(2000).optional(),
  priceMinor: z.number().int().min(0).max(999999999999).nullable().optional(),
  currency: z.enum(["RUB", "USD", "EUR"]).nullable().optional(),
};
const validPrice = (body: { priceMinor?: number | null; currency?: string | null }) =>
  (body.priceMinor === undefined && body.currency === undefined) ||
  (body.priceMinor === null && body.currency === null) ||
  (typeof body.priceMinor === "number" && typeof body.currency === "string");
const createItemSchema = z.object(itemFields).strict().refine(validPrice, "Укажите цену и валюту вместе.");
const patchItemSchema = z.object({ ...itemFields, title: itemFields.title.optional(), completed: z.boolean().optional() })
  .strict().refine(body => Object.keys(body).length > 0).refine(validPrice, "Укажите цену и валюту вместе.");
function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value);
  if (!result.success) throw new FamilyError(400, "Проверьте имя, название, ссылку и цену.");
  return result.data;
}
type Profile = { id: string; name: string; createdByUserId: string; itemCount: number; completedCount: number };
const profileSelect = `SELECT p.id,p.name,p.created_by_user_id AS createdByUserId,
  (SELECT count(*) FROM wishlist_items i WHERE i.family_id=p.family_id AND i.profile_id=p.id) AS itemCount,
  (SELECT count(*) FROM wishlist_items i WHERE i.family_id=p.family_id AND i.profile_id=p.id AND i.completed=1) AS completedCount
  FROM wishlist_profiles p`;
const itemSelect = `SELECT i.id,i.title,i.url,i.note,i.price_minor AS priceMinor,i.currency,i.completed,
  i.created_at AS createdAt,i.updated_at AS updatedAt,i.completed_at AS completedAt,
  a.first_name AS author,c.first_name AS completedBy
  FROM wishlist_items i JOIN users a ON a.id=i.created_by_user_id LEFT JOIN users c ON c.id=i.completed_by_user_id`;

export function createWishlistsRouter(db: Database.Database) {
  const router = Router();
  const atomic = (handler: RequestHandler): RequestHandler => (request, response, next) => {
    db.transaction(() => handler(request, response, next)).immediate();
  };
  function familyFor(user: string) {
    const family = findFamily(db, user);
    if (!family) throw new FamilyError(403, "Сначала создайте семью или вступите по приглашению.");
    return family;
  }
  function profile(family: string, id: string) {
    const result = db.prepare(`${profileSelect} WHERE p.family_id=? AND p.id=?`).get(family, id) as Profile | undefined;
    if (!result) throw new FamilyError(404, "Вишлист не найден. Возможно, его удалил другой участник.");
    return result;
  }
  function canManage(target: Profile, user: string, role: string) { return role === "owner" || target.createdByUserId === user; }
  function requireManage(target: Profile, user: string, role: string) {
    if (!canManage(target, user, role)) throw new FamilyError(403, "Изменять имя и удалять вишлист может его создатель или владелец семьи.");
  }
  function requireItem(family: string, id: string) {
    const item = db.prepare("SELECT id,completed FROM wishlist_items WHERE family_id=? AND id=?").get(family, id) as { id: string; completed: number } | undefined;
    if (!item) throw new FamilyError(404, "Желание не найдено. Возможно, его удалил другой участник.");
    return item;
  }
  router.get("/wishlists", (_request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user);
    const profiles = db.prepare(`${profileSelect} WHERE p.family_id=? ORDER BY p.created_at,p.rowid`).all(family.id) as Profile[];
    response.json({ profiles: profiles.map(p => ({ ...p, canManage: canManage(p, user, family.role) })) });
  });
  router.post("/wishlists", atomic((request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user);
    const { name } = parse(nameSchema, request.body), id = randomUUID();
    db.prepare("INSERT INTO wishlist_profiles(id,family_id,name,created_by_user_id) VALUES (?,?,?,?)").run(id, family.id, name, user);
    response.status(201).json({ id });
  }));
  router.get("/wishlists/:id", (request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user);
    const p = profile(family.id, parse(idSchema, request.params.id));
    const items = db.prepare(`${itemSelect} WHERE i.family_id=? AND i.profile_id=? ORDER BY i.created_at,i.rowid`).all(family.id, p.id) as { completed: number }[];
    response.json({ profile: { ...p, canManage: canManage(p, user, family.role) }, items: items.map(i => ({ ...i, completed: Boolean(i.completed) })) });
  });
  router.patch("/wishlists/:id", atomic((request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user);
    const p = profile(family.id, parse(idSchema, request.params.id));
    requireManage(p, user, family.role);
    const { name } = parse(nameSchema, request.body);
    db.prepare("UPDATE wishlist_profiles SET name=?,updated_at=unixepoch() WHERE family_id=? AND id=?").run(name, family.id, p.id);
    response.status(204).end();
  }));
  router.delete("/wishlists/:id", atomic((request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user);
    const p = profile(family.id, parse(idSchema, request.params.id));
    requireManage(p, user, family.role); parse(emptySchema, request.body);
    db.prepare("DELETE FROM wishlist_profiles WHERE family_id=? AND id=?").run(family.id, p.id);
    response.status(204).end();
  }));
  router.post("/wishlists/:id/items", atomic((request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user);
    const p = profile(family.id, parse(idSchema, request.params.id));
    const body = parse(createItemSchema, request.body), id = randomUUID();
    db.prepare("INSERT INTO wishlist_items(id,family_id,profile_id,title,url,note,price_minor,currency,created_by_user_id,updated_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, family.id, p.id, body.title, body.url ?? null, body.note ?? null, body.priceMinor ?? null, body.currency ?? null, user, user);
    response.status(201).json({ id });
  }));
  router.patch("/wishlist-items/:id", atomic((request, response) => {
    const user = sessionFrom(response).user.id, family = familyFor(user), id = parse(idSchema, request.params.id);
    const item = requireItem(family.id, id), body = parse(patchItemSchema, request.body);
    const mapping = { title: "title", url: "url", note: "note", priceMinor: "price_minor", currency: "currency" } as const;
    const keys = (Object.keys(mapping) as (keyof typeof mapping)[]).filter(key => body[key] !== undefined);
    if (keys.length) db.prepare(`UPDATE wishlist_items SET ${keys.map(key => `${mapping[key]}=?`).join(",")},updated_by_user_id=?,updated_at=unixepoch() WHERE family_id=? AND id=?`)
      .run(...keys.map(key => body[key]!), user, family.id, id);
    if (body.completed !== undefined && Number(body.completed) !== item.completed) {
      db.prepare("UPDATE wishlist_items SET completed=?,completed_at=CASE WHEN ? THEN unixepoch() ELSE NULL END,completed_by_user_id=?,updated_by_user_id=?,updated_at=unixepoch() WHERE family_id=? AND id=?")
        .run(Number(body.completed), Number(body.completed), body.completed ? user : null, user, family.id, id);
    }
    response.status(204).end();
  }));
  router.delete("/wishlist-items/:id", atomic((request, response) => {
    const family = familyFor(sessionFrom(response).user.id), id = parse(idSchema, request.params.id);
    requireItem(family.id, id); parse(emptySchema, request.body);
    db.prepare("DELETE FROM wishlist_items WHERE family_id=? AND id=?").run(family.id, id);
    response.status(204).end();
  }));
  return router;
}
