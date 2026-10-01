import { useState } from "react";

export default function WriteAccess() {
  const app = window.Telegram?.WebApp;
  // This flag is only a UI hint, never server-side authorization to send messages.
  const [allowed, setAllowed] = useState(app?.initDataUnsafe?.user?.allows_write_to_pm === true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!app?.initData) return null;
  const supported = app.isVersionAtLeast?.("6.9") && app.requestWriteAccess;
  return <details className="settings-panel"><summary>Сообщения от бота</summary>
    <p className="muted">Разрешите боту писать вам в Telegram. Ежедневные уведомления появятся позже.</p>
    {allowed ? <p role="status">Разрешение получено.</p> : supported ? <button disabled={busy} onClick={() => {
      setBusy(true); setMessage("");
      try {
        app.requestWriteAccess?.(result => { setAllowed(result); setBusy(false); setMessage(result ? "" : "Разрешение не предоставлено. Можно продолжать пользоваться приложением."); });
      } catch { setBusy(false); setMessage("Не удалось запросить разрешение. Попробуйте открыть приложение заново."); }
    }}>{busy ? "Ожидаем ответ…" : "Разрешить сообщения"}</button> : <p>Обновите Telegram, чтобы разрешить сообщения из приложения.</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}
