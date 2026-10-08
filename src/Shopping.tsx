import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "./api/http";
import { ConfirmDialog, Empty, ErrorNotice, Loading } from "./components/States";
import { navigate, type Route } from "./navigation";

type Item = { id: string; title: string; quantity: string | null; note: string | null; bought: boolean };
type List = { id: string; closedAt: number | null; closedByName: string | null; itemCount: number };
type Detail = { list: List; items: Item[] };
type Confirmation = { kind: "close" | "list" | "item"; id: string; title?: string };
type Draft = { id?: string; listId?: string; title: string; quantity: string; note: string };
const blank: Draft = { title: "", quantity: "", note: "" };

export default function Shopping({ route, timezone, back }: { route: Route; timezone: string; back: () => void }) {
  const history = route === "shopping/history";
  const archivedId = route.startsWith("shopping/history/") ? route.split("/")[2] : null;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const inFlight = useRef(false);
  const request = useRef({ sequence: 0 });
  const form = useRef<HTMLFormElement>(null);
  const listId = detail?.list.id;
  const draftOpen = draft !== null;
  const draftId = draft?.id;
  const readonly = detail?.list.closedAt !== null;
  const endpoint = history ? "/api/shopping-lists/history" : archivedId ? `/api/shopping-lists/${archivedId}` : "/api/shopping-lists/current";
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++request.current.sequence;
    try {
      if (history) {
        const result = await apiRequest<{ lists: List[] }>(endpoint, { signal });
        if (sequence === request.current.sequence && !signal?.aborted) setLists(result.lists);
      } else {
        const result = await apiRequest<Detail>(endpoint, { signal });
        if (sequence === request.current.sequence && !signal?.aborted) setDetail(result);
      }
      if (sequence === request.current.sequence && !signal?.aborted) setError("");
    } catch (err) {
      if (sequence === request.current.sequence && !signal?.aborted) setError(err instanceof Error ? err.message : "Не удалось загрузить покупки.");
    } finally { if (sequence === request.current.sequence && !signal?.aborted) setLoading(false); }
  }, [history, endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    const activeRequest = request.current;
    const update = () => { if (!document.hidden && !inFlight.current) void refresh(controller.signal); };
    update();
    const interval = window.setInterval(update, 15000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => { controller.abort(); activeRequest.sequence++; window.clearInterval(interval); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [refresh]);
  useEffect(() => {
    if (draftOpen) form.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [draftId, draftOpen]);

  async function mutate(work: () => Promise<unknown>, message: string, done?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true; request.current.sequence++; setBusy(true); setError(""); setNotice("");
    try {
      await work();
      setConfirmation(null); setNotice(message); done?.();
      await refresh();
    } catch (err) {
      // Refresh a stale/closed list but retain the user's draft and the failure message.
      await refresh();
      setError(err instanceof Error ? err.message : "Не удалось сохранить изменения.");
      setConfirmation(null);
    } finally { inFlight.current = false; setBusy(false); }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !listId) return;
    const { title, quantity, note } = draft;
    void mutate(() => apiRequest(draft.id ? `/api/shopping-items/${draft.id}` : "/api/shopping-lists/current/items", {
      method: draft.id ? "PATCH" : "POST", body: JSON.stringify({ title, quantity, note, ...(!draft.id ? { listId: draft.listId } : {}) }),
    }), draft.id ? "Покупка изменена." : "Покупка добавлена.", () => setDraft(null));
  }
  function confirm() {
    if (!confirmation) return;
    const target = confirmation;
    if (target.kind === "close") void mutate(() => apiRequest("/api/shopping-lists/current/close", { method: "POST", body: JSON.stringify({ listId: target.id }) }), "Список закрыт. Новый список готов.", () => setDraft(null));
    else if (target.kind === "list") void mutate(() => apiRequest(`/api/shopping-lists/${target.id}`, { method: "DELETE", body: "{}" }), "Список удалён.", () => navigate("shopping/history", true));
    else void mutate(() => apiRequest(`/api/shopping-items/${target.id}`, { method: "DELETE", body: "{}" }), "Покупка удалена.");
  }
  const date = (value: number) => new Date(value * 1000).toLocaleString("ru-RU", { timeZone: timezone, dateStyle: "long", timeStyle: "short" });
  const visible = detail?.items.filter(item => readonly || showAll || !item.bought) || [];
  return <section className="shopping-screen" aria-busy={busy}>
    <button className="text-button back-button" disabled={busy} onClick={back}>← {archivedId ? "К истории" : history ? "К покупкам" : "На главную"}</button>
    <h1 data-screen-heading tabIndex={-1}>{history ? "История покупок" : archivedId ? "Закрытый список" : "Список покупок"}</h1>
    {error && <ErrorNotice message={error} retry={() => void refresh()} />}
    {notice && <p role="status">{notice}</p>}
    {loading ? <Loading /> : history ? <>
      {!lists.length ? <Empty>История пока пуста. Закрытые списки появятся здесь.</Empty> : <ul className="shopping-history">
        {lists.map(list => <li key={list.id}><button onClick={() => navigate(`shopping/history/${list.id}`)}>
          <strong>{date(list.closedAt!)}</strong><span>Позиций: {list.itemCount}</span><small>Закрыл(а): {list.closedByName}</small>
        </button></li>)}
      </ul>}
    </> : detail && <>
      {readonly ? <p className="muted">{date(detail.list.closedAt!)} · {detail.list.closedByName}. Список доступен только для просмотра.</p> : <>
        <div className="button-row"><button className="primary" disabled={busy || draftOpen} onClick={() => setDraft({ ...blank, listId })}>Добавить покупку</button>
          <button disabled={busy} onClick={() => navigate("shopping/history")}>История</button></div>
        {draft && <form ref={form} onSubmit={save} className="shopping-form">
          <h2>{draft.id ? "Изменить покупку" : "Новая покупка"}</h2>
          {draft.listId !== listId && <div><p role="status">Другой участник закрыл список. Ваш текст сохранён в форме.</p><button type="button" disabled={busy} onClick={() => setDraft({ ...draft, id: undefined, listId })}>Добавить в новый список</button></div>}
          <label htmlFor="purchase-title">Название</label><input id="purchase-title" required maxLength={200} value={draft.title} disabled={busy} onChange={event => setDraft({ ...draft, title: event.target.value })} />
          <label htmlFor="purchase-quantity">Количество <span className="muted">(необязательно)</span></label><input id="purchase-quantity" maxLength={100} placeholder="Например, 2 упаковки" value={draft.quantity} disabled={busy} onChange={event => setDraft({ ...draft, quantity: event.target.value })} />
          <label htmlFor="purchase-note">Заметка <span className="muted">(необязательно)</span></label><textarea id="purchase-note" maxLength={2000} value={draft.note} disabled={busy} onChange={event => setDraft({ ...draft, note: event.target.value })} />
          <div className="button-row"><button className="primary" disabled={busy || !draft.title.trim() || draft.listId !== listId}>{busy ? "Сохраняем…" : "Сохранить"}</button><button type="button" disabled={busy} onClick={() => setDraft(null)}>Отмена</button></div>
        </form>}
        <button aria-pressed={showAll} disabled={busy} onClick={() => setShowAll(value => !value)}>{showAll ? "Скрыть купленные" : "Показать все"}</button>
      </>}
      {!visible.length && <Empty>{detail.items.length ? "Всё куплено. Нажмите «Показать все», чтобы увидеть покупки." : "Список пуст."}</Empty>}
      <ul className="shopping-items">{visible.map(item => <li key={item.id} className={item.bought ? "completed-task" : ""}>
        <div className="purchase-heading">{!readonly && <label className="purchase-check"><input type="checkbox" checked={item.bought} disabled={busy} aria-label={`${item.bought ? "Вернуть в покупки" : "Куплено"}: ${item.title}`}
          onChange={() => void mutate(() => apiRequest(`/api/shopping-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ bought: !item.bought }) }), item.bought ? "Покупка возвращена в список." : "Отмечено как купленное.")} /></label>}
          <strong className={item.bought ? "completed" : ""}>{item.title}</strong></div>
        {item.quantity && <p>Количество: {item.quantity}</p>}{item.note && <p className="purchase-note">{item.note}</p>}
        {readonly && <small>{item.bought ? "Куплено" : "Не куплено"}</small>}
        {!readonly && <div className="button-row"><button disabled={busy || draftOpen} onClick={() => setDraft({ id: item.id, listId, title: item.title, quantity: item.quantity || "", note: item.note || "" })}>Изменить</button>
          <button className="danger" disabled={busy} onClick={() => setConfirmation({ kind: "item", id: item.id, title: item.title })}>Удалить</button></div>}
      </li>)}</ul>
      <button className="danger" disabled={busy} onClick={() => setConfirmation({ kind: readonly ? "list" : "close", id: detail.list.id })}>{readonly ? "Удалить закрытый список" : "Закрыть список"}</button>
    </>}
    {confirmation && <ConfirmDialog busy={busy} title={confirmation.kind === "close" ? "Закрыть список покупок?" : confirmation.kind === "list" ? "Удалить закрытый список?" : `Удалить «${confirmation.title}»?`}
      confirmLabel={confirmation.kind === "close" ? "Закрыть список" : "Удалить"} onConfirm={confirm} onCancel={() => setConfirmation(null)}>
      <p>{confirmation.kind === "close" ? "Все позиции, включая некупленные, перейдут в историю. Появится новый пустой список." : "Это действие нельзя отменить."}</p>
      {error && <ErrorNotice message={error} />}
    </ConfirmDialog>}
  </section>;
}
