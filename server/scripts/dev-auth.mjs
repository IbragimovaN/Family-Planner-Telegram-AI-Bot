import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Explicit local-only mode. No .env editing or real Telegram token is needed.
const child = spawn(process.execPath, ["--import", "tsx", "--watch", "src/index.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, NODE_ENV: "development", DEV_AUTH_ENABLED: "true", APP_ORIGIN: "http://localhost:5173", PORT: process.env.PORT || "3000" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 0; });
child.on("error", () => { console.error("Could not start local development server"); process.exitCode = 1; });
