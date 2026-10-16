import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "./api/http";
import { ConfirmDialog, Empty, ErrorNotice, Loading } from "./components/States";
import { navigate, type Route } from "./navigation";
import { TrashIcon, PencilIcon } from "./components/ShoppingIcons";

type Item = { id: string; title: string; bought: boolean };
type List = { id: string; closedAt: number | null; closedByName: string | null; itemCount: number };
type Detail = { list: List; items: Item[]; sortingRevision?: string | null };
type Confirmation = { kind: "close" | "list"; id: string };
type Draft = { id?: string; listId?: string; title: string };

export default function Shopping({ route, timezone, back }: { route: Route; timezone: string; back: () => void }) {
  const general = route === "purchases";
  const createEndpoint = general ? "/api/purchases" : "/api/shopping-lists/current/items";
  const itemEndpoint = general ? "/api/purchases" : "/api/shopping-items";
  const history = route === "shopping/history";
  const archivedId = route.startsWith("shopping/history/") ? route.split("/")[2] : null;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(0);
  const scrollArea = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [quick, setQuick] = useState({ title: "", listId: "" });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [inputActive, setInputActive] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [sortedToast, setSortedToast] = useState(false);
  const inFlight = useRef(false);
  const request = useRef({ sequence: 0 });
  const form = useRef<HTMLFormElement>(null);
  const listId = detail?.list.id;
  const draftOpen = draft !== null;
  const draftId = draft?.id;
  const readonly = detail?.list.closedAt !== null;
  const endpoint = general ? "/api/purchases" : history ? "/api/shopping-lists/history" : archivedId ? `/api/shopping-lists/${archivedId}` : "/api/shopping-lists/current";
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
    if (draftOpen) form.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [draftId, draftOpen]);
  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const sortingRevision = detail?.sortingRevision;
  useEffect(() => {
    if (general || history || readonly || !listId || !sortingRevision || inputActive || busy || draftOpen || confirmation || !pageVisible) return;
    const controller = new AbortController();
    let timer: number;
    const sort = async () => {
      if (controller.signal.aborted || document.hidden || inFlight.current || document.activeElement?.id === "purchase-add-title") return;
      try {
        const result = await apiRequest<{ sorting: "applied" | "skipped" | "deferred" | "unavailable" }>("/api/shopping-lists/current/sort", {
          method: "POST", body: JSON.stringify({ listId }), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.sorting === "applied") {
          setSortedToast(true);
          await refresh(controller.signal);
        } else if (result.sorting === "deferred") {
          timer = window.setTimeout(() => void sort(), 10000);
        } else if (result.sorting === "skipped") {
          await refresh(controller.signal);
        }
        // On AI failure keep the saved list, without automatic retry loops.
      } catch { /* Adding and editing remain available if background sorting fails. */ }
    };
    timer = window.setTimeout(() => void sort(), 10000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [general, history, readonly, listId, sortingRevision, inputActive, quick.title, busy, draftOpen, confirmation, pageVisible, refresh]);
  useEffect(() => {
    if (!sortedToast) return;
    const timer = window.setTimeout(() => setSortedToast(false), 2000);
    return () => window.clearTimeout(timer);
  }, [sortedToast]);

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
    const { title } = draft;
    void mutate(() => apiRequest(draft.id ? `${itemEndpoint}/${draft.id}` : createEndpoint, {
      method: draft.id ? "PATCH" : "POST", body: JSON.stringify({ title, ...(!draft.id && !general ? { listId: draft.listId } : {}) }),
    }), draft.id ? "Покупка изменена." : "Покупка добавлена.", () => setDraft(null));
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quick.title.trim() || quick.listId !== listId) return;
    void mutate(() => apiRequest(createEndpoint, {
      method: "POST", body: JSON.stringify({ title: quick.title, ...(!general ? { listId: quick.listId } : {}) }),
    }), "Покупка добавлена.", () => { setQuick({ title: "", listId: "" }); setPage(Math.floor(visible.length / 20)); })
      .then(() => window.requestAnimationFrame(() => scrollArea.current?.scrollTo({ top: scrollArea.current.scrollHeight })));
  }
  function confirm() {
    if (!confirmation) return;
    const target = confirmation;
    if (target.kind === "close") void mutate(() => apiRequest("/api/shopping-lists/current/close", { method: "POST", body: JSON.stringify({ listId: target.id }) }), "Список закрыт. Новый список готов.", () => setDraft(null));
    else if (target.kind === "list") void mutate(() => apiRequest(`/api/shopping-lists/${target.id}`, { method: "DELETE", body: "{}" }), "Список удалён.", () => navigate("shopping/history", true));
  }
  const date = (value: number) => new Date(value * 1000).toLocaleString("ru-RU", { timeZone: timezone, dateStyle: "long", timeStyle: "short" });
  const visible = detail?.items.filter(item => readonly || showAll || !item.bought || item.id === draft?.id) || [];
  const pageCount = Math.max(1, Math.ceil(visible.length / 20));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = visible.slice(currentPage * 20, (currentPage + 1) * 20);
  useEffect(() => { scrollArea.current?.scrollTo({ top: 0 }); }, [currentPage, showAll, listId]);
  function turnPage(next: number) { setPage(Math.max(0, Math.min(next, pageCount - 1))); }
  return <section className={`shopping-screen${!history ? " shopping-viewport" : ""}${general ? " purchases-screen" : ""}`} aria-busy={busy}>
    <div className="shopping-navigation">
      <button className="text-button back-button" disabled={busy} onClick={back}>← {archivedId ? "К истории" : history ? "К покупкам" : "На главную"}</button>
      {!general && !history && !archivedId && <button className="text-button" disabled={busy} onClick={() => navigate("shopping/history")}>История</button>}
    </div>
    <h1 className={!history && !archivedId ? "sr-only" : undefined} data-screen-heading tabIndex={-1}>{general ? "Покупки" : history ? "История покупок" : archivedId ? "Закрытый список" : "Список покупок — продукты"}</h1>
    {error && <ErrorNotice message={error} retry={() => void refresh()} />}
    {notice && <p className="sr-only" role="status">{notice}</p>}
    {sortedToast && <div className="shopping-sorted-toast" role="status">Список отсортирован</div>}
    {loading ? <Loading /> : history ? <>
      {!lists.length ? <Empty>История пока пуста. Закрытые списки появятся здесь.</Empty> : <ul className="shopping-history">
        {lists.map(list => <li key={list.id}><button onClick={() => navigate(`shopping/history/${list.id}`)}>
          <strong>{date(list.closedAt!)}</strong><span>Позиций: {list.itemCount}</span><small>Закрыл(а): {list.closedByName}</small>
        </button></li>)}
      </ul>}
    </> : detail && <>
      {readonly ? <p className="muted">{date(detail.list.closedAt!)} · {detail.list.closedByName}. Список доступен только для просмотра.</p> : <>
        <form className="shopping-quick-add" onSubmit={add}>
          <label className="sr-only" htmlFor="purchase-add-title">Название товара</label>
          <input id="purchase-add-title" placeholder="Введите товар" required maxLength={200} readOnly={busy} onFocus={() => setInputActive(true)} onBlur={() => setInputActive(false)}
            value={quick.title} onChange={event => setQuick({ title: event.target.value, listId: quick.title ? quick.listId : listId! })} />
          <button className="primary" disabled={busy || !quick.title.trim() || quick.listId !== listId}>Добавить</button>
        </form>
        {quick.title && quick.listId !== listId && <div><p role="status">Другой участник закрыл список. Ваш текст сохранён в форме.</p><button disabled={busy} onClick={() => setQuick({ ...quick, listId: listId! })}>Добавить в новый список</button></div>}
        {draft && !detail.items.some(item => item.id === draft.id) && <div>
          <p role="status">Список изменился. Сохранённый текст: {draft.title}</p>
          <button disabled={busy} onClick={() => { setQuick({ title: draft.title, listId: listId! }); setDraft(null); }}>Вернуть текст в поле добавления</button>
          <button disabled={busy} onClick={() => setDraft(null)}>Отмена</button>
        </div>}
      </>}
      {!readonly && detail.items.length > 0 && <button type="button" className="purchase-filter-toggle" role="switch" aria-checked={!showAll} disabled={busy || draftOpen} onClick={() => { setShowAll(value => !value); setPage(0); }}><span>Скрывать купленные</span><span className="purchase-switch-track" aria-hidden="true"><span /></span></button>}
      <div className="shopping-list-scroll" ref={scrollArea} role="region" aria-label="Позиции списка" tabIndex={0}>
      {!visible.length && <Empty>{detail.items.length ? "Всё куплено. Выключите «Скрывать купленные», чтобы увидеть покупки." : "Список пуст."}</Empty>}
      <ul className="shopping-items">{pageItems.map(item => <li key={item.id} className={item.bought ? "completed-task" : ""}>
        {!readonly && <label className="purchase-check"><input type="checkbox" checked={item.bought} disabled={busy || draft?.id === item.id} aria-label={`${item.bought ? "Вернуть в покупки" : "Куплено"}: ${item.title}`}
          onChange={() => void mutate(() => apiRequest(`${itemEndpoint}/${item.id}`, { method: "PATCH", body: JSON.stringify({ bought: !item.bought }) }), item.bought ? "Покупка возвращена в список." : "Отмечено как купленное.")} /></label>}
        {!readonly ? <form ref={draft?.id === item.id ? form : undefined} onSubmit={event => { if (draft?.id === item.id) save(event); else event.preventDefault(); }} className="purchase-edit-row" onKeyDown={event => { if (event.key === "Escape" && !busy) setDraft(null); }}>
          {draft?.id !== item.id ? <span className={`purchase-title-text${item.bought ? " completed" : ""}`} title={item.title}>{item.title}</span> : <input className={`purchase-title${item.bought ? " completed" : ""}`} id={draft?.id === item.id ? "purchase-title" : undefined}
            aria-label={draft?.id === item.id ? "Название покупки" : `Покупка: ${item.title}`} readOnly={draft?.id !== item.id} tabIndex={draft?.id === item.id ? 0 : -1}
            required maxLength={200} value={draft?.id === item.id ? draft.title : item.title} disabled={busy}
            onChange={event => { if (draft?.id === item.id) setDraft({ ...draft, title: event.target.value }); }} />}
          {draft?.id === item.id ? <>
          <button key="save" type="submit" className="edit-action" aria-label="Сохранить" title="Сохранить" disabled={busy || !draft.title.trim() || draft.listId !== listId}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
          </button>
          <button key="cancel" type="button" className="edit-action edit-cancel" aria-label="Отмена" title="Отмена" disabled={busy} onClick={() => setDraft(null)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
          </> : <>
            <button key="edit" type="button" className="icon-button" aria-label={`Редактировать: ${item.title}`} title="Редактировать" disabled={busy || draftOpen} onClick={event => { event.preventDefault(); setDraft({ id: item.id, listId, title: item.title }); }}><PencilIcon /></button>
            <button key="delete" type="button" className="icon-button icon-delete" aria-label={`Удалить: ${item.title}`} title="Удалить" disabled={busy} onClick={() => void mutate(() => apiRequest(`${itemEndpoint}/${item.id}`, { method: "DELETE", body: "{}" }), "Покупка удалена.")}><TrashIcon /></button>
          </>}
        </form> : <div className="purchase-content purchase-content-readonly">
          <span className={`purchase-title-text${item.bought ? " completed" : ""}`} title={item.title}>{item.title}</span>
          {readonly && <small>{item.bought ? "Куплено" : "Не куплено"}</small>}
        </div>
        }
      </li>)}</ul>
      </div>
      {pageCount > 1 && <nav className="shopping-pagination" aria-label="Страницы покупок"><button type="button" aria-label="Предыдущая страница" disabled={busy || draftOpen || currentPage === 0} onClick={() => turnPage(currentPage - 1)}>←</button><span aria-live="polite">{currentPage + 1} / {pageCount}<small>{visible.length} позиций</small></span><button type="button" aria-label="Следующая страница" disabled={busy || draftOpen || currentPage === pageCount - 1} onClick={() => turnPage(currentPage + 1)}>→</button></nav>}
      {!general && (readonly || detail.items.length > 0) && <button type="button" className={readonly ? "danger purchase-list-action" : "danger"} disabled={busy} onClick={() => setConfirmation({ kind: readonly ? "list" : "close", id: detail.list.id })}>{readonly ? "Удалить закрытый список" : "Закрыть список"}</button>}
    </>}
    {confirmation && <ConfirmDialog busy={busy} title={confirmation.kind === "close" ? "Закрыть список покупок?" : "Удалить закрытый список?"}
      confirmLabel={confirmation.kind === "close" ? "Закрыть список" : "Удалить"} onConfirm={confirm} onCancel={() => setConfirmation(null)}>
      <p>{confirmation.kind === "close" ? "Все позиции, включая некупленные, перейдут в историю. Появится новый пустой список." : "Это действие нельзя отменить."}</p>
      {error && <ErrorNotice message={error} />}
    </ConfirmDialog>}
  </section>;
}
