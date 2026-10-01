import { useEffect, useState } from "react";
import FamilyGate from "./FamilyGate";
import { ApiError, apiRequest } from "./api/http";

type Profile = { user: { id: string; firstName: string; lastName: string | null; username: string | null; photoUrl: string | null }; authMethod: "telegram" | "dev" };
type State = { status: "loading" | "outside" | "ready" | "error" | "signedOut"; profile?: Profile; message?: string; devAllowed?: boolean };

async function bootstrap(): Promise<State> {
  const initData = window.Telegram?.WebApp.initData || "";
  window.Telegram?.WebApp.ready();
  const { devLoginEnabled } = await apiRequest<{ devLoginEnabled: boolean }>("/api/auth/config", {}, false);
  const devAllowed = import.meta.env.DEV && devLoginEnabled;
  if (!initData && !devAllowed) return { status: "outside" };
  try {
    const profile = await apiRequest<Profile>("/api/me", {}, false);
    return { status: "ready", profile, devAllowed };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
  }
  if (!initData) return { status: "outside", devAllowed };
  await apiRequest("/api/auth/telegram", { method: "POST", body: JSON.stringify({ initData }) }, false);
  return { status: "ready", profile: await apiRequest<Profile>("/api/me", {}, false), devAllowed };
}

// StrictMode mounts effects twice in development; share only the in-flight bootstrap.
let initialRequest: Promise<State> | undefined;

export default function AuthGate() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    initialRequest ??= bootstrap().finally(() => { initialRequest = undefined; });
    initialRequest.then(result => { if (active) setState(result); }).catch(() => {
      if (active) setState({ status: "error", message: "Не удалось войти. Проверьте подключение или откройте приложение через бота заново." });
    });
    const expired = () => setState(current => ({ status: "signedOut", devAllowed: current.devAllowed, message: "Сессия завершилась. Войдите снова." }));
    window.addEventListener("session-expired", expired);
    return () => { active = false; window.removeEventListener("session-expired", expired); };
  }, []);

  async function login(devProfile = "local") {
    if (busy) return;
    setBusy(true);
    try {
      const initData = window.Telegram?.WebApp.initData || "";
      if (initData) {
        await apiRequest("/api/auth/telegram", { method: "POST", body: JSON.stringify({ initData }) }, false);
      } else if (import.meta.env.DEV && state.devAllowed) {
        await apiRequest("/api/auth/dev", { method: "POST", body: JSON.stringify({ profile: devProfile }) }, false);
      } else {
        setState(await bootstrap());
        return;
      }
      setState({ status: "ready", profile: await apiRequest<Profile>("/api/me", {}, false), devAllowed: state.devAllowed });
    } catch (error) {
      setState(current => ({ ...current, status: "error", message: error instanceof Error ? error.message : "Не удалось войти." }));
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try {
      await apiRequest("/api/auth/logout", { method: "POST", body: "{}" }, false);
      setState({ status: "signedOut", devAllowed: state.devAllowed });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setState({ status: "signedOut", devAllowed: state.devAllowed });
      else setState(current => ({ ...current, message: "Не удалось выйти. Попробуйте ещё раз." }));
    } finally { setBusy(false); }
  }

  if (state.status === "ready" && state.profile) {
    return <FamilyGate key={state.profile.user.id} user={state.profile.user} dev={state.profile.authMethod === "dev"} onLogout={logout} logoutBusy={busy} authMessage={state.message} />;
  }
  return <main className="app auth-screen">
    <h1>Family Planner</h1>
    {state.status === "loading" ? <p role="status">Проверяем вход…</p> : <>
      <h2>{state.status === "signedOut" ? "Вы вышли из приложения" : state.status === "error" ? "Не удалось войти" : "Откройте приложение через бота"}</h2>
      <p>{state.message || "В Telegram откройте чат с ботом и нажмите кнопку приложения."}</p>
      {state.devAllowed && import.meta.env.DEV && <p>Локальный режим разработки</p>}
      {(state.devAllowed || state.status === "error" || state.status === "signedOut") &&
        <button className="primary" type="button" onClick={() => void login()} disabled={busy}>{busy ? "Входим…" : state.devAllowed ? "Войти как тестовый пользователь" : "Повторить вход"}</button>}
      {state.devAllowed && import.meta.env.DEV && <button type="button" disabled={busy} onClick={() => void login("second")}>Войти как второй участник</button>}
    </>}
  </main>;
}
