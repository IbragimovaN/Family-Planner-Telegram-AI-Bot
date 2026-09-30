export type AuthConfig = {
  production: boolean;
  devEnabled: boolean;
  origin: string;
  botToken?: string;
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
  return {
    production, devEnabled, origin: url.origin,
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    sessionSeconds: 7 * 24 * 60 * 60,
    initDataSeconds: 5 * 60,
  };
}
