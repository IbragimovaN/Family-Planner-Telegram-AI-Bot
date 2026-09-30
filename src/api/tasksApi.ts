import type { Task } from "../types/task";
import { apiRequest } from "./http";

export const getTasks = (): Promise<Task[]> => apiRequest("/api/tasks");

export const createTask = (title: string): Promise<Task> => apiRequest("/api/tasks", {
  method: "POST", body: JSON.stringify({ title }),
});

export const toggleTask = (taskId: string): Promise<Task> => apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/toggle`, {
  method: "PATCH", body: "{}",
});

export const parseTasks = async (text: string): Promise<string[]> => {
  const data = await apiRequest<{ tasks: string[] }>("/api/ai/tasks", {
    method: "POST", body: JSON.stringify({ text }),
  });
  return data.tasks;
};
