import type { Task } from "../types/task";

const TASKS_URL = "/api/tasks";

export const getTasks = async (): Promise<Task[]> => {
  const response = await fetch(TASKS_URL);

  if (!response.ok) {
    throw new Error("Не удалось загрузить задачи");
  }

  return response.json();
};

export const createTask = async (title: string): Promise<Task> => {
  const response = await fetch(TASKS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title }),
  });

  if (!response.ok) {
    throw new Error("Не удалось создать задачу");
  }

  return response.json();
};

export const toggleTask = async (taskId: string): Promise<Task> => {
  const response = await fetch(`${TASKS_URL}/${taskId}/toggle`, {
    method: "PATCH",
  });

  if (!response.ok) {
    throw new Error("Не удалось изменить задачу");
  }

  return response.json();
};

export const parseTasks = async (text: string): Promise<string[]> => {
  const response = await fetch("/api/ai/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw new Error("Не удалось обработать сообщение");
  }

  const data = (await response.json()) as {
    tasks: string[];
  };

  return data.tasks;
};
