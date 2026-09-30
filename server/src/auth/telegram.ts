import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const userSchema = z.object({
  id: z.number().int().positive().refine(Number.isSafeInteger),
  first_name: z.string().trim().min(1).max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().url().max(2048).refine(value => new URL(value).protocol === "https:").optional(),
  is_bot: z.boolean().optional(),
}).refine(user => !user.is_bot);

export type TelegramUser = z.infer<typeof userSchema>;

export function validateInitData(raw: string, botToken: string, maxAge: number, now = Math.floor(Date.now() / 1000)): TelegramUser {
  const invalid = () => new Error("Invalid Telegram authorization data");
  if (!raw || raw.length > 16384) throw invalid();
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw invalid();
  const hash = params.get("hash");
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) throw invalid();
  params.delete("hash");
  params.sort();
  const data = [...params].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(data).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw invalid();
  const authDate = params.get("auth_date") || "";
  if (!/^\d+$/.test(authDate)) throw invalid();
  const timestamp = Number(authDate);
  if (!Number.isSafeInteger(timestamp) || timestamp > now + 30 || now - timestamp > maxAge) throw invalid();
  try {
    return userSchema.parse(JSON.parse(params.get("user") || "null"));
  } catch {
    throw invalid();
  }
}
