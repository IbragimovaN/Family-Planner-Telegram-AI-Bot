import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sessionFrom } from "./auth/routes.js";
import { FamilyError, findFamily } from "./family.js";
import { localDate, periodStart, periodEnd, overdueCount, validDate, type Period } from "./task-dates.js";
import { taskInput, parseInput, type TaskParser } from "./task-input.js";
import { parseTasks } from "./tasks-ai.js";

type Row = { id: string; family_id: string; owner_user_id: string; created_by_user_id: string; title: string; description: string | null; period_type: Period; planned_date: string; planned_time: string | null; original_period_type: Period; original_planned_date: string; completed: number; completed_at: number | null; created_at: number; updated_at: number; author: string };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new FamilyError(400, "Проверьте название, дату, период и время дела.");
  return result.data;
}
const select = `SELECT t.*,trim(u.first_name || ' ' || coalesce(u.last_name,'')) AS author FROM tasks t JOIN users u ON u.id=t.created_by_user_id`;
export function createTasksRouter(db: Database.Database, parser: TaskParser = parseTasks, now: () => number = Date.now) {
  const router = Router();
  const atomic = (handler: RequestHandler): RequestHandler => (req, res, next) => { db.transaction(() => handler(req, res, next)).immediate(); };
  function context(user: string, owner = user) {
    const family = findFamily(db, user);
    if (!family) throw new FamilyError(403, "Сначала вступите в семью.");
    if (!db.prepare("SELECT 1 FROM family_members WHERE family_id=? AND user_id=?").get(family.id, owner)) throw new FamilyError(404, "Участник не найден.");
    return { ...family, owner, today: localDate(family.timezone, now()) };
  }
  function owned(user: string, id: string) {
    const family = context(user);
    const task = db.prepare(`${select} WHERE t.id=? AND t.family_id=?`).get(id, family.id) as Row | undefined;
    if (!task) throw new FamilyError(404, "Дело не найдено.");
    if (task.owner_user_id !== user) throw new FamilyError(403, "Изменять дело может только владелец списка.");
    return task;
  }
  function view(row: Row, today: string, timezone: string) {
    const overdue = row.completed ? 0 : overdueCount(row.planned_date, row.period_type, today);
    const completedDate = row.completed_at === null ? null : localDate(timezone, row.completed_at * 1000);
    return { id: row.id, ownerUserId: row.owner_user_id, createdByUserId: row.created_by_user_id, author: row.author,
      title: row.title, description: row.description || "", periodType: row.period_type, plannedDate: row.planned_date, plannedTime: row.planned_time,
      originalPeriodType: row.original_period_type, originalPlannedDate: row.original_planned_date,
      completed: Boolean(row.completed), completedAt: row.completed_at, completedDate, createdAt: row.created_at, updatedAt: row.updated_at,
      overdue, effectiveDate: completedDate || (overdue ? periodStart(today, row.period_type) : row.planned_date) };
  }
  // Copy old records once. Originals remain intact; deleted imported tasks never reappear.
  function importLegacy(owner: string, family: ReturnType<typeof context>) {
    db.transaction(() => {
      const old = db.prepare("SELECT p.* FROM prototype_tasks p WHERE owner_user_id=? AND NOT EXISTS (SELECT 1 FROM task_legacy_imports i WHERE i.prototype_id=p.id)").all(owner) as { id: string; title: string; completed: number; created_at: string | number }[];
      for (const row of old) {
        const id = randomUUID();
        const timestamp = typeof row.created_at === "number" ? row.created_at : Math.floor(Date.parse(String(row.created_at).replace(" ", "T") + "Z") / 1000);
        const created = Number.isFinite(timestamp) ? timestamp : Math.floor(now() / 1000);
        const date = localDate(family.timezone, created * 1000);
        db.prepare(`INSERT INTO tasks(id,family_id,owner_user_id,created_by_user_id,title,description,period_type,planned_date,original_period_type,original_planned_date,completed,completed_at,created_at)
          VALUES (?,?,?,?,?,?,'date',?,'date',?,?,?,?)`).run(id, family.id, owner, owner, row.title,
          row.completed ? "Перенесено из прежнего списка. Прежняя дата выполнения не сохранялась; в истории указана дата переноса." : "Перенесено из прежнего списка без планового срока; первоначальная дата — дата создания.",
          date, date, row.completed, row.completed ? Math.floor(now() / 1000) : null, created);
        db.prepare("INSERT INTO task_legacy_imports(prototype_id,task_id) VALUES (?,?)").run(row.id, id);
      }
    }).immediate();
  }
  router.get("/tasks", (req, res) => {
    const user = sessionFrom(res).user.id;
    const query = parse(z.object({ owner: z.string().optional(), period: z.enum(["date", "week", "month"]).default("date"), date: z.string().refine(validDate).optional(), status: z.enum(["active", "all"]).default("active"), mode: z.enum(["days", "undated"]).default("days") }).strict(), req.query);
    const family = context(user, query.owner || user); importLegacy(family.owner, family);
    const date = query.date || family.today;
    const start = periodStart(date, query.period), end = periodEnd(date, query.period);
    const rows = db.prepare(`${select} WHERE t.family_id=? AND t.owner_user_id=?`).all(family.id, family.owner) as Row[];
    const tasks = rows.map(row => view(row, family.today, family.timezone)).filter(task => {
      if (task.completed) return query.status === "all" && task.completedDate! >= start && task.completedDate! <= end &&
        (query.mode !== "undated" || query.period === "date" || task.periodType === query.period);
      if (query.mode === "undated" && query.period !== "date") return task.periodType === query.period && task.effectiveDate === start;
      return task.periodType === "date" && task.effectiveDate >= start && task.effectiveDate <= end;
    }).sort((a, b) => Number(a.completed) - Number(b.completed) || a.effectiveDate.localeCompare(b.effectiveDate) || (a.plannedTime || "99:99").localeCompare(b.plannedTime || "99:99") || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    res.json({ tasks, today: family.today, timezone: family.timezone, ownerUserId: family.owner, canEdit: user === family.owner });
  });
  router.post("/tasks", atomic((req, res) => {
    const user = sessionFrom(res).user.id;
    const body = parse(z.object({ ownerUserId: z.string(), tasks: z.array(taskInput).min(1).max(20) }).strict(), req.body);
    const family = context(user, body.ownerUserId);
    const ids = body.tasks.map(task => {
      const id = randomUUID();
      db.prepare(`INSERT INTO tasks(id,family_id,owner_user_id,created_by_user_id,title,description,period_type,planned_date,planned_time,original_period_type,original_planned_date,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, family.id, body.ownerUserId, user, task.title, task.description, task.periodType, task.plannedDate, task.plannedTime, task.periodType, task.plannedDate, Math.floor(now()/1000), Math.floor(now()/1000));
      return id;
    });
    res.status(201).json({ ids });
  }));
  const parsing = new Set<string>();
  const parseAttempts = new Map<string, { count: number; until: number }>();
  router.post("/tasks/parse", async (req, res) => {
    const user = sessionFrom(res).user.id, family = context(user);
    const input = parse(parseInput, req.body);
    if (parsing.has(user)) throw new FamilyError(429, "Дождитесь предыдущего разбора.");
    for (const [id, entry] of parseAttempts) if (entry.until <= now()) parseAttempts.delete(id);
    const attempts = parseAttempts.get(user) || { count: 0, until: now() + 60_000 };
    if (attempts.count >= 10) throw new FamilyError(429, "Слишком много запросов к AI. Попробуйте через минуту или заполните вручную.");
    attempts.count++; parseAttempts.set(user, attempts);
    parsing.add(user);
    try {
      const tasks = parse(z.array(taskInput).min(1).max(20), await parser({ ...input, today: family.today, timezone: family.timezone }));
      if (context(user).id !== family.id) throw new FamilyError(403, "Состав семьи изменился.");
      res.json({ tasks });
    } catch (error) {
      if (error instanceof FamilyError && error.status === 403) throw error;
      throw new FamilyError(503, "AI сейчас недоступен. Заполните дело вручную.");
    } finally { parsing.delete(user); }
  });
  router.patch("/tasks/:id", atomic((req, res) => {
    const task = owned(sessionFrom(res).user.id, req.params.id as string);
    const body = parse(taskInput, req.body);
    db.prepare("UPDATE tasks SET title=?,description=?,period_type=?,planned_date=?,planned_time=?,updated_at=? WHERE id=?").run(body.title, body.description, body.periodType, body.plannedDate, body.plannedTime, Math.floor(now()/1000), task.id);
    res.status(204).end();
  }));
  for (const operation of ["complete", "reopen"] as const) router.post(`/tasks/:id/${operation}`, atomic((req, res) => {
    parse(z.object({}).strict(), req.body);
    const task = owned(sessionFrom(res).user.id, req.params.id as string);
    const completed = operation === "complete";
    if (Boolean(task.completed) !== completed) db.prepare("UPDATE tasks SET completed=?,completed_at=?,updated_at=? WHERE id=?").run(Number(completed), completed ? Math.floor(now()/1000) : null, Math.floor(now()/1000), task.id);
    res.status(204).end();
  }));
  router.delete("/tasks/:id", atomic((req, res) => {
    parse(z.object({}).strict(), req.body);
    const task = owned(sessionFrom(res).user.id, req.params.id as string);
    db.prepare("DELETE FROM tasks WHERE id=?").run(task.id); res.status(204).end();
  }));
  return router;
}
