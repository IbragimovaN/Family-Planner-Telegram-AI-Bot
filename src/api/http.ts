export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}, notifyExpired = true): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Family-Planner": "1", ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { message?: string } | null;
    if (response.status === 401 && notifyExpired) window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(data?.message || "Не удалось выполнить запрос. Попробуйте ещё раз.", response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}
