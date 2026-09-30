import express, { type ErrorRequestHandler } from "express";
import type Database from "better-sqlite3";
import { createAuth, sessionFrom } from "./auth/routes.js";
import type { AuthConfig } from "./auth/config.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Task = {
  id: string;
  title: string;
  completed: boolean;
};

type TaskRow = {
  id: string;
  title: string;
  completed: number;
};

export function createApp(database: Database.Database, config: AuthConfig) {
const app = express();
app.disable("x-powered-by");

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);

const frontendDistPath = join(currentDirectory, "../../dist");

const auth = createAuth(database, config);
app.use("/api", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  response.set("X-Content-Type-Options", "nosniff");
  next();
});
app.use("/api", auth.mutationGuard);
app.use(express.json({ limit: "24kb" }));

const convertTaskRow = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  completed: Boolean(row.completed),
});

app.get("/api/health", (_request, response) => {
  database.prepare("SELECT 1 FROM schema_migrations LIMIT 1").get();
  response.json({
    status: "ok",
  });
});

app.use("/api/auth", auth.router);
// Deny by default: every subsequent API route requires a valid session.
app.use("/api", auth.requireSession);
app.get("/api/me", (_request, response) => {
  const { user, method } = sessionFrom(response);
  response.json({ user: {
    id: user.id, firstName: user.first_name, lastName: user.last_name,
    username: user.username, photoUrl: user.photo_url,
  }, authMethod: method });
});

app.get("/api/tasks", (_request, response) => {
  const rows = database
    .prepare(
      `
      SELECT id, title, completed
      FROM prototype_tasks
      WHERE owner_user_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(sessionFrom(response).user.id) as TaskRow[];

  response.json(rows.map(convertTaskRow));
});

app.post("/api/tasks", (request, response) => {
  const { title } = (request.body || {}) as {
    title?: unknown;
  };

  if (typeof title !== "string" || !title.trim() || title.length > 500) {
    response.status(400).json({
      message: "Название задачи обязательно",
    });

    return;
  }

  const newTask: Task = {
    id: crypto.randomUUID(),
    title: title.trim(),
    completed: false,
  };

  database
    .prepare(
      `
      INSERT INTO prototype_tasks (id, title, completed, owner_user_id)
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(newTask.id, newTask.title, Number(newTask.completed), sessionFrom(response).user.id);

  response.status(201).json(newTask);
});

app.patch("/api/tasks/:id/toggle", (request, response) => {
  const row = database
    .prepare(
      `
      SELECT id, title, completed
      FROM prototype_tasks
      WHERE id = ? AND owner_user_id = ?
    `,
    )
    .get(request.params.id, sessionFrom(response).user.id) as TaskRow | undefined;

  if (!row) {
    response.status(404).json({
      message: "Задача не найдена",
    });

    return;
  }

  const updatedTask: Task = {
    ...convertTaskRow(row),
    completed: !row.completed,
  };

  database
    .prepare(
      `
      UPDATE prototype_tasks
      SET completed = ?
      WHERE id = ? AND owner_user_id = ?
    `,
    )
    .run(Number(updatedTask.completed), updatedTask.id, sessionFrom(response).user.id);

  response.json(updatedTask);
});

app.post("/api/ai/tasks", async (request, response) => {
  const { text } = (request.body || {}) as {
    text?: unknown;
  };

  if (typeof text !== "string" || !text.trim() || text.length > 4000) {
    response.status(400).json({
      message: "Текст сообщения обязателен",
    });

    return;
  }

  try {
    const { parseTaskTitles } = await import("./ai.js");
    const taskTitles = await parseTaskTitles(text.trim());

    response.json({
      tasks: taskTitles,
    });
  } catch {
    console.error("AI task parsing failed");

    response.status(500).json({
      message: "Не удалось обработать сообщение",
    });
  }
});

app.use("/api", (_request, response) => {
  response.status(404).json({ message: "Не найдено" });
});

app.use(express.static(frontendDistPath));

app.use((request, response, next) => {
  if (request.path.startsWith("/api")) {
    next();
    return;
  }

  response.sendFile(join(frontendDistPath, "index.html"));
});

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  void _next;
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (status === 400 || status === 413) {
    response.status(status).json({ message: "Некорректный или слишком большой запрос." });
    return;
  }
  console.error("Request failed");
  response.status(500).json({ message: "Не удалось выполнить запрос." });
};
app.use(errorHandler);
return app;
}
