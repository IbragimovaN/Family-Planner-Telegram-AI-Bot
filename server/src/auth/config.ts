import { isIP } from "node:net";

export type AuthConfig = {
  trustedProxies: string[];
  production: boolean;
  devEnabled: boolean;
  origin: string;
  botToken?: string;
  botUsername?: string;
  sessionSeconds: number;
  initDataSeconds: number;
};

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env.NODE_ENV === "production";
  const devEnabled = env.DEV_AUTH_ENABLED === "true";
  if (devEnabled && env.NODE_ENV !== "development") {
    throw new Error("DEV_AUTH_ENABLED is allowed only with NODE_ENV=development.");
  }
  if (production && (!env.APP_ORIGIN || !env.TELEGRAM_BOT_TOKEN?.trim())) {
    throw new Error("Production requires APP_ORIGIN and TELEGRAM_BOT_TOKEN.");
  }
  const url = new URL(env.APP_ORIGIN || "http://localhost:5173");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !["http:", "https:"].includes(url.protocol) ||
      (url.protocol !== "https:" && (production || !local)) || (devEnabled && !local)) {
    throw new Error("APP_ORIGIN must be an HTTPS origin, or a local development origin without a path.");
  }
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") || undefined;
  const trustedProxies = (env.TRUSTED_PROXY_IPS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (trustedProxies.some(value => !isIP(value))) throw new Error("TRUSTED_PROXY_IPS must contain explicit proxy IP addresses, separated by commas.");
  if (botUsername && !/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Error("Invalid TELEGRAM_BOT_USERNAME.");
  return {
    production, devEnabled, origin: url.origin, trustedProxies,
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined, botUsername,
    sessionSeconds: 7 * 24 * 60 * 60,
    initDataSeconds: 5 * 60,
  };
}
