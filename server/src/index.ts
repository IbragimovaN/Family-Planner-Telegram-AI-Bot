import { parseTaskTitles } from "./ai.js";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import database from "./database.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

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

const app = express();
const port = Number(process.env.PORT) || 3000;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);

const frontendDistPath = join(currentDirectory, "../../dist");

app.use(
  cors({
    origin: "http://localhost:5173",
  }),
);

app.use(express.json());

const convertTaskRow = (row: TaskRow): Task => ({
  id: row.id,
  title: row.title,
  completed: Boolean(row.completed),
});

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
  });
});

app.get("/api/tasks", (_request, response) => {
  const rows = database
    .prepare(
      `
      SELECT id, title, completed
      FROM tasks
      ORDER BY created_at ASC
    `,
    )
    .all() as TaskRow[];

  response.json(rows.map(convertTaskRow));
});

app.post("/api/tasks", (request, response) => {
  const { title } = request.body as {
    title?: unknown;
  };

  if (typeof title !== "string" || !title.trim()) {
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
      INSERT INTO tasks (id, title, completed)
      VALUES (?, ?, ?)
    `,
    )
    .run(newTask.id, newTask.title, Number(newTask.completed));

  response.status(201).json(newTask);
});

app.patch("/api/tasks/:id/toggle", (request, response) => {
  const row = database
    .prepare(
      `
      SELECT id, title, completed
      FROM tasks
      WHERE id = ?
    `,
    )
    .get(request.params.id) as TaskRow | undefined;

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
      UPDATE tasks
      SET completed = ?
      WHERE id = ?
    `,
    )
    .run(Number(updatedTask.completed), updatedTask.id);

  response.json(updatedTask);
});

app.post("/api/ai/tasks", async (request, response) => {
  const { text } = request.body as {
    text?: unknown;
  };

  if (typeof text !== "string" || !text.trim()) {
    response.status(400).json({
      message: "Текст сообщения обязателен",
    });

    return;
  }

  try {
    const taskTitles = await parseTaskTitles(text.trim());

    response.json({
      tasks: taskTitles,
    });
  } catch (error) {
    console.error("OpenAI request failed:", error);

    response.status(500).json({
      message: "Не удалось обработать сообщение",
    });
  }
});

app.use(express.static(frontendDistPath));

app.use((request, response, next) => {
  if (request.path.startsWith("/api")) {
    next();
    return;
  }

  response.sendFile(join(frontendDistPath, "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Server started: http://localhost:${port}`);
});
