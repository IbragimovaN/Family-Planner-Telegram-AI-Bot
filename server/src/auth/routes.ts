import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AuthConfig } from "./config.js";
import { validateInitData, type TelegramUser } from "./telegram.js";

type UserRow = {
  id: string; telegram_id: string; first_name: string; last_name: string | null;
  username: string | null; photo_url: string | null;
};
export type AuthSession = { user: UserRow; sessionId: string; method: "telegram" | "dev" };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const loopback = (ip?: string) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip || "");

export function sessionFrom(response: Response): AuthSession {
  return response.locals.auth as AuthSession;
}

export function createAuth(db: Database.Database, config: AuthConfig) {
  const router = Router();
  const secure = config.origin.startsWith("https:");
  const cookieName = secure ? "__Host-family_session" : "family_session";
  const cookieOptions = { httpOnly: true, secure, sameSite: secure ? "none" as const : "lax" as const, path: "/" };
  const localDevRequest = (request: Request) => config.devEnabled && loopback(request.socket.remoteAddress) && !request.get("x-forwarded-for");
  function tokenFrom(request: Request): string | undefined {
    const values = (request.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    if (values.length !== 1) return undefined;
    const value = values[0].slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  }

  const mutationGuard: RequestHandler = (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    if (request.get("origin") !== config.origin || request.get("x-family-planner") !== "1" || !request.is("application/json")) {
      response.status(403).json({ message: "Запрос отклонён. Откройте приложение заново." });
      return;
    }
    next();
  };

  const requireSession: RequestHandler = (request, response, next) => {
    const token = tokenFrom(request);
    const row = token ? db.prepare(`SELECT u.*, s.id AS session_id, s.auth_method
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(digest(token), Math.floor(Date.now() / 1000)) as
      (UserRow & { session_id: string; auth_method: "telegram" | "dev" }) | undefined : undefined;
    if (!row || (row.auth_method === "dev" && !localDevRequest(request))) {
      response.clearCookie(cookieName, cookieOptions);
      response.status(401).json({ message: "Сессия завершилась. Войдите снова." });
      return;
    }
    const { session_id, auth_method, ...user } = row;
    response.locals.auth = { user, sessionId: session_id, method: auth_method } satisfies AuthSession;
    next();
  };

  // Bounded per-process limiter. Forwarded IPs are accepted only from configured proxies.
  const attempts = new Map<string, { count: number; until: number }>();
  const rateLimit: RequestHandler = (request, response, next) => {
    const now = Date.now();
    for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    const key = request.ip || "unknown";
    const entry = attempts.get(key) || { count: 0, until: now + 60_000 };
    if (entry.count >= 20 || (!attempts.has(key) && attempts.size >= 10000)) {
      response.set("Retry-After", "60").status(429).json({ message: "Слишком много попыток входа. Подождите минуту." });
      return;
    }
    entry.count++;
    attempts.set(key, entry);
    next();
  };

  function login(request: Request, response: Response, user: TelegramUser, method: "telegram" | "dev", devProfile = "local") {
    const now = Math.floor(Date.now() / 1000);
    const token = randomBytes(32).toString("hex");
    const telegramId = method === "dev" ? `dev:${devProfile}` : String(user.id);
    const currentToken = tokenFrom(request);
    db.transaction(() => {
      db.prepare(`INSERT INTO users (id, telegram_id, first_name, last_name, username, photo_url)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET
        first_name=excluded.first_name, last_name=excluded.last_name, username=excluded.username,
        photo_url=excluded.photo_url, updated_at=unixepoch()`)
        .run(randomUUID(), telegramId, user.first_name, user.last_name || null, user.username || null, user.photo_url || null);
      const saved = db.prepare("SELECT id FROM users WHERE telegram_id=?").get(telegramId) as { id: string };
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      if (currentToken) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(currentToken));
      db.prepare("INSERT INTO sessions (id,token_hash,user_id,expires_at,auth_method) VALUES (?,?,?,?,?)")
        .run(randomUUID(), digest(token), saved.id, now + config.sessionSeconds, method);
    }).immediate();
    response.cookie(cookieName, token, { ...cookieOptions, maxAge: config.sessionSeconds * 1000 });
    response.status(204).end();
  }

  router.get("/config", (request, response) => {
    response.json({ devLoginEnabled: localDevRequest(request) });
  });
  router.post("/telegram", rateLimit, (request, response) => {
    const body = z.object({ initData: z.string().min(1).max(16384) }).strict().safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ message: "Нужны данные входа из Telegram." });
      return;
    }
    if (!config.botToken) {
      response.status(503).json({ message: "Вход через Telegram пока не настроен." });
      return;
    }
    let user: TelegramUser;
    try {
      user = validateInitData(body.data.initData, config.botToken, config.initDataSeconds);
    } catch {
      response.status(401).json({ message: "Не удалось подтвердить вход. Закройте приложение и откройте его через бота снова." });
      return;
    }
    login(request, response, user, "telegram");
  });
  router.post("/dev", rateLimit, (request, response) => {
    if (!localDevRequest(request)) {
      response.status(404).json({ message: "Не найдено" });
      return;
    }
    const body = z.object({ profile: z.enum(["local", "second"]).default("local") }).strict().safeParse(request.body);
    if (!body.success) {
      response.status(400).json({ message: "Некорректный запрос" });
      return;
    }
    login(request, response, { id: 1, first_name: body.data.profile === "local" ? "Тестовый пользователь" : "Второй участник" }, "dev", body.data.profile);
  });
  router.post("/logout", requireSession, (request, response) => {
    db.prepare("DELETE FROM sessions WHERE id=?").run(sessionFrom(response).sessionId);
    response.clearCookie(cookieName, cookieOptions);
    response.status(204).end();
  });
  return { router, requireSession, mutationGuard };
}
