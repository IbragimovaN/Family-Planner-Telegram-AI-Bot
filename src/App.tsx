import { useEffect, useState, type FormEvent } from "react";
import { createTask, getTasks, toggleTask, parseTasks } from "./api/tasksApi";
import type { Task } from "./types/task";
import "./App.css";

function App() {
  const [title, setTitle] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aiText, setAiText] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const visibleTasks = showCompleted
    ? tasks
    : tasks.filter((task) => task.completed === false);

  useEffect(() => {
    const loadTasks = async () => {
      try {
        const loadedTasks = await getTasks();
        setTasks(loadedTasks);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Произошла ошибка");
      } finally {
        setIsLoading(false);
      }
    };

    loadTasks();
  }, []);

  const handleAiSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedText = aiText.trim();

    if (!trimmedText) {
      return;
    }

    try {
      setError(null);
      setIsAiLoading(true);

      const taskTitles = await parseTasks(trimmedText);

      const createdTasks = await Promise.all(
        taskTitles.map((taskTitle) => createTask(taskTitle)),
      );

      setTasks((currentTasks) => [...currentTasks, ...createdTasks]);

      setAiText("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Произошла ошибка");
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      return;
    }

    try {
      setError(null);

      const newTask = await createTask(trimmedTitle);

      setTasks((currentTasks) => [...currentTasks, newTask]);
      setTitle("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Произошла ошибка");
    }
  };

  const handleToggle = async (taskId: string) => {
    try {
      setError(null);

      const updatedTask = await toggleTask(taskId);

      setTasks((currentTasks) =>
        currentTasks.map((task) =>
          task.id === updatedTask.id ? updatedTask : task,
        ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Произошла ошибка");
    }
  };

  return (
    <main className="app">
      <h1>Family Planner</h1>

      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Введите задачу"
        />

        <button type="submit">Добавить</button>
      </form>
      <form onSubmit={handleAiSubmit}>
        <input
          type="text"
          value={aiText}
          onChange={(event) => setAiText(event.target.value)}
          placeholder="Например: купить молоко и позвонить врачу"
          disabled={isAiLoading}
        />

        <button type="submit" disabled={isAiLoading}>
          {isAiLoading ? "Обрабатываю..." : "Добавить с AI"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}

      <div className="task-toolbar">
        <button
          type="button"
          className="filter-button"
          aria-pressed={showCompleted}
          onClick={() => setShowCompleted((current) => !current)}
        >
          {showCompleted ? "Скрыть выполненные" : "Показать все"}
        </button>
      </div>

      {isLoading ? (
        <p>Загрузка...</p>
      ) : (
        <>
          {visibleTasks.length === 0 && !error && (
            <p className="empty-state" role="status">
              {showCompleted ? "Пока нет задач" : "Все задачи выполнены"}
            </p>
          )}
          <ul className="task-list">
            {visibleTasks.map((task) => (
              <li
                key={task.id}
                className={task.completed ? "completed-task" : ""}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={task.completed}
                    onChange={() => handleToggle(task.id)}
                  />

                  <span className={task.completed ? "completed" : ""}>
                    {task.title}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

export default App;
