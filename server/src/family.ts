import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sessionFrom } from "./auth/routes.js";
import type { AuthConfig } from "./auth/config.js";

export class FamilyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type Family = { id: string; name: string; timezone: string; role: "owner" | "member" };
export function findFamily(db: Database.Database, userId: string): Family | null {
  return db.prepare(`SELECT f.id,f.name,f.timezone,m.role FROM family_members m
    JOIN families f ON f.id=m.family_id WHERE m.user_id=?`).get(userId) as Family | undefined || null;
}
const name = z.string().trim().min(1).max(100);
const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Неизвестный часовой пояс");
const createSchema = z.object({ name, timezone: timezone.default("Europe/Moscow") }).strict();
const patchSchema = z.object({ name: name.optional(), timezone: timezone.optional() }).strict().refine(value => Object.keys(value).length > 0);
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const emptySchema = z.object({}).strict();
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FamilyError(400, "Проверьте введённые данные: название, часовой пояс или код приглашения.");
  return result.data;
}

export function createFamilyRouter(db: Database.Database, config: AuthConfig) {
  const router = Router();
  function requireFamily(userId: string, owner = false) {
    const family = findFamily(db, userId);
    if (!family) throw new FamilyError(403, "Сначала создайте семью или вступите по приглашению.");
    if (owner && family.role !== "owner") throw new FamilyError(403, "Это действие доступно только владельцу семьи.");
    return family;
  }
  const attempts = new Map<string, { count: number; until: number }>();
  const limit: RequestHandler = (_request, response, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const id = sessionFrom(response).user.id;
    const entry = attempts.get(id) || { count: 0, until: now + 60_000 };
    if (entry.count >= 20 || (!attempts.has(id) && attempts.size >= 10000)) {
      response.set("Retry-After", "60").status(429).json({ message: "Слишком много запросов. Подождите минуту." });
      return;
    }
    entry.count++; attempts.set(id, entry); next();
  };
  // All membership decisions and writes execute in the same SQLite transaction.
  const atomic = (handler: RequestHandler): RequestHandler => (request, response, next) => {
    db.transaction(() => handler(request, response, next)).immediate();
  };

  router.get("/family", (_request, response) => response.json({ family: findFamily(db, sessionFrom(response).user.id) }));
  router.post("/families", limit, atomic((request, response) => {
    const body = parse(createSchema, request.body);
    const userId = sessionFrom(response).user.id;
    if (findFamily(db, userId)) throw new FamilyError(409, "Вы уже состоите в семье.");
    const id = randomUUID();
    db.prepare("INSERT INTO families (id,name,timezone) VALUES (?,?,?)").run(id, body.name, body.timezone);
    db.prepare("INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'owner')").run(id, userId);
    db.prepare("INSERT INTO shopping_lists (id,family_id) VALUES (?,?)").run(randomUUID(), id);
    response.status(201).json({ family: findFamily(db, userId) });
  }));
  router.patch("/family", atomic((request, response) => {
    const body = parse(patchSchema, request.body);
    const family = requireFamily(sessionFrom(response).user.id, true);
    db.prepare("UPDATE families SET name=?,timezone=?,updated_at=unixepoch() WHERE id=?")
      .run(body.name ?? family.name, body.timezone ?? family.timezone, family.id);
    response.json({ family: findFamily(db, sessionFrom(response).user.id) });
  }));
  router.get("/family/members", (_request, response) => {
    const family = requireFamily(sessionFrom(response).user.id);
    const members = db.prepare(`SELECT u.id,u.first_name AS firstName,u.last_name AS lastName,
      u.username,u.photo_url AS photoUrl,m.role,m.joined_at AS joinedAt
      FROM family_members m JOIN users u ON u.id=m.user_id WHERE m.family_id=?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,m.joined_at,u.id`).all(family.id);
    response.json({ members });
  });
  router.delete("/family/members/:userId", atomic((request, response) => {
    parse(emptySchema, request.body);
    const family = requireFamily(sessionFrom(response).user.id, true);
    const target = db.prepare("SELECT role FROM family_members WHERE family_id=? AND user_id=?").get(family.id, request.params.userId) as { role: string } | undefined;
    if (!target) throw new FamilyError(404, "Участник не найден.");
    if (target.role === "owner") throw new FamilyError(409, "Удаление владельца семьи недоступно.");
    db.prepare("DELETE FROM family_members WHERE family_id=? AND user_id=?").run(family.id, request.params.userId);
    response.status(204).end();
  }));
  router.get("/family/invitations", (_request, response) => {
    const family = requireFamily(sessionFrom(response).user.id, true);
    const invitations = db.prepare(`SELECT id,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt
      FROM invitations WHERE family_id=? ORDER BY created_at DESC,id LIMIT 100`).all(family.id);
    response.json({ invitations });
  });
  router.post("/family/invitations", limit, atomic((request, response) => {
    parse(emptySchema, request.body);
    const family = requireFamily(sessionFrom(response).user.id, true);
    if (config.production && !config.botUsername) throw new FamilyError(503, "Приглашения пока не настроены. Нужен username бота на сервере.");
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + 7 * 24 * 60 * 60;
    db.prepare("INSERT INTO invitations (id,family_id,token_hash,created_by_user_id,expires_at) VALUES (?,?,?,?,?)")
      .run(id, family.id, tokenHash(token), sessionFrom(response).user.id, expiresAt);
    const parameter = `invite_${token}`;
    const url = sessionFrom(response).method === "dev"
      ? `${config.origin}/?invite=${token}`
      : config.botUsername ? `https://t.me/${config.botUsername}?startapp=${parameter}` : null;
    response.status(201).json({ invitation: { id, createdAt, expiresAt, revokedAt: null }, token, url });
  }));
  router.delete("/family/invitations/:id", atomic((request, response) => {
    parse(emptySchema, request.body);
    const family = requireFamily(sessionFrom(response).user.id, true);
    const result = db.prepare("UPDATE invitations SET revoked_at=COALESCE(revoked_at,unixepoch()) WHERE id=? AND family_id=?").run(request.params.id, family.id);
    if (!result.changes) throw new FamilyError(404, "Приглашение не найдено.");
    response.status(204).end();
  }));
  router.post("/family/join", limit, atomic((request, response) => {
    const { token } = parse(tokenSchema, request.body);
    const invitation = db.prepare("SELECT family_id FROM invitations WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?")
      .get(tokenHash(token), Math.floor(Date.now() / 1000)) as { family_id: string } | undefined;
    if (!invitation) throw new FamilyError(410, "Приглашение недействительно или срок его действия истёк.");
    const userId = sessionFrom(response).user.id;
    const existing = findFamily(db, userId);
    if (existing && existing.id !== invitation.family_id) throw new FamilyError(409, "Вы уже состоите в другой семье.");
    if (!existing) db.prepare("INSERT INTO family_members (family_id,user_id,role) VALUES (?,?,'member')").run(invitation.family_id, userId);
    response.json({ family: findFamily(db, userId) });
  }));
  return router;
}
