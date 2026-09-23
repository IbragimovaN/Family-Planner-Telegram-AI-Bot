import "dotenv/config";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI();

const taskListSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
    }),
  ),
});

export const parseTaskTitles = async (userText: string): Promise<string[]> => {
  const response = await openai.responses.parse({
    model: "gpt-5.6-luna",
    input: [
      {
        role: "system",
        content:
          "Раздели сообщение пользователя на отдельные короткие задачи. " +
          "Не добавляй информацию, которой нет в сообщении. " +
          "Если в сообщении нет задач, верни пустой массив.",
      },
      {
        role: "user",
        content: userText,
      },
    ],
    text: {
      format: zodTextFormat(taskListSchema, "task_list"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI не вернул результат");
  }

  return response.output_parsed.tasks.map((task) => task.title.trim());
};
