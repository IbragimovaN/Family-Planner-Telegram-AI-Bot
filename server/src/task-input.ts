import { z } from "zod";
import { periodStart, validDate } from "./task-dates.js";
export const taskInput = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4000).default(""),
  periodType: z.enum(["date", "week", "month"]),
  plannedDate: z.string().refine(validDate),
  plannedTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
}).strict().refine(v => v.plannedDate === periodStart(v.plannedDate, v.periodType) && (v.periodType === "date" || v.plannedTime === null), "Проверьте период, дату и время.");
export type TaskInput = z.infer<typeof taskInput>;
export const parseInput = z.object({ text: z.string().trim().min(1).max(4000), periodType: z.enum(["date", "week", "month"]), date: z.string().refine(validDate) }).strict();
export type ParseContext = z.infer<typeof parseInput> & { today: string; timezone: string };
export type TaskParser = (context: ParseContext) => Promise<TaskInput[]>;
