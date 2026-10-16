import PastelSelect from "./components/PastelSelect";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import "./App.css";
import { apiRequest } from "./api/http";
import { ConfirmDialog, ErrorNotice, Loading } from "./components/States";
import { compactDateLabel, dayLabel, daysOf, movePeriod, startOf, todayIn, type Period } from "./task-calendar";

type Member = { id: string; firstName: string; lastName: string | null };
type Draft = { title: string; description: string; periodType: Period; plannedDate: string; plannedTime: string | null };
type Task = Draft & { id: string; ownerUserId: string; author: string; originalPeriodType: Period; originalPlannedDate: string; completed: boolean; completedAt: number | null; createdAt: number; overdue: number; effectiveDate: string };
type Result = { tasks: Task[]; canEdit: boolean; today: string; timezone: string; ownerUserId: string };
const periodNames = { date: "День", week: "Неделя", month: "Месяц" };
function TaskEmpty({ children }: { children: ReactNode }) {
  return <div className="task-empty"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="3" /><path d="m8 12 3 3 5-6" /></svg><p>{children}</p></div>;
}
function Modal({ title, children, close, busy }: { title: string; children: ReactNode; close: () => void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement, node = dialog.current; node?.showModal();
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog task-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="task-dialog-heading"><h2>{title}</h2><button type="button" aria-label="Закрыть" disabled={busy} onClick={close}>×</button></div>{children}
  </dialog>;
}
  const overdueLabel = (task: Task) => task.overdue ? `Просрочено: ${task.overdue} ${task.periodType === "date" ? "дн." : task.periodType === "week" ? "нед." : "мес."} · Срок ${task.plannedDate}` : "";
function TaskCards({ tasks, own, busy, onDrag, onToggle, onDetail }: { tasks: Task[]; own: boolean; busy: boolean; onDrag: (task: Task | null) => void; onToggle: (task: Task) => void; onDetail: (task: Task) => void }) {
    return <ul className="task-list planner-task-list">{tasks.map(task => <li key={task.id} draggable={own && !task.completed && !busy} onDragStart={event => { event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; onDrag(task); }} onDragEnd={() => { onDrag(null); }} className={`${task.completed ? "completed-task" : ""} ${task.overdue ? task.overdue > 1 ? "task-overdue-old" : "task-overdue" : ""}`}>
      {own && !task.completed && <span className="task-drag-handle" aria-hidden="true" title="Перетащите дело на другой день">⠿</span>}{own && <input type="checkbox" checked={task.completed} disabled={busy} aria-label={`${task.completed ? "Вернуть" : "Выполнить"}: ${task.title}`} onChange={() => onToggle(task)} />}
      <button type="button" className="task-open" onClick={() => { onDetail(task); }}><span className={`task-card-title${task.completed ? " completed" : ""}`}>{task.title}</span>{task.plannedTime && <small className="task-card-time">{task.plannedTime}</small>}{task.description && <small className="task-snippet">{task.description}</small>}{task.overdue > 0 && <small className="task-overdue-label">{overdueLabel(task)}</small>}</button>
      <button type="button" className="task-card-menu" aria-label={`Открыть детали: ${task.title}`} onClick={() => onDetail(task)}>⋮</button>
    </li>)}</ul>;
  }

export default function Tasks({ userId, members, timezone, onBack, fromHome = false }: { userId: string; members: Member[]; timezone: string; onBack: () => void; fromHome?: boolean }) {
  const [owner, setOwner] = useState(userId);
  const [period, setPeriod] = useState<Period>("date");
  const [date, setDate] = useState(() => todayIn(timezone));
  const [mode, setMode] = useState<"days" | "undated">("days");
  const [all, setAll] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(fromHome);
  const [chooseOwner, setChooseOwner] = useState(fromHome);
  const [targetOwner, setTargetOwner] = useState(userId);
  const [drafts, setDrafts] = useState<Draft[]>(() => [{ title: "", description: "", periodType: "date", plannedDate: todayIn(timezone), plannedTime: null }]);
  const [text, setText] = useState("");
  const [quickTitle, setQuickTitle] = useState("");
  const [quickDate, setQuickDate] = useState(() => todayIn(timezone));
  const [aiOpen, setAiOpen] = useState(fromHome);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [formError, setFormError] = useState("");
  const sequence = useRef({ value: 0 }), inFlight = useRef(false), alive = useRef(true);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef<Task | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const own = owner === userId;
  const query = new URLSearchParams({ owner, period, date, status: all ? "all" : "active", mode }).toString();
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++sequence.current.value;
    try {
      const data = await apiRequest<Result>(`/api/tasks?${query}`, { signal });
      if (alive.current && id === sequence.current.value && !signal?.aborted) { setResult(data); setError(""); }
    } catch (err) { if (alive.current && id === sequence.current.value && !signal?.aborted) setError(err instanceof Error ? err.message : "Не удалось загрузить дела."); }
    finally { if (alive.current && id === sequence.current.value && !signal?.aborted) setLoading(false); }
  }, [query]);
  useEffect(() => { const request = sequence.current; alive.current = true; return () => { alive.current = false; request.value++; }; }, []);
  useEffect(() => {
    const controller = new AbortController(), request = sequence.current;
    const update = () => { if (!document.hidden && !inFlight.current) void refresh(controller.signal); };
    update(); const timer = window.setInterval(update, 15000); window.addEventListener("focus", update);
    return () => { controller.abort(); request.value++; clearInterval(timer); window.removeEventListener("focus", update); };
  }, [refresh]);
  async function mutate(work: () => Promise<unknown>, done?: () => void) {
    if (inFlight.current) return; inFlight.current = true; sequence.current.value++; setBusy(true); setError(""); setFormError("");
    try { await work(); if (!alive.current) return; done?.(); setNotice("Изменения сохранены."); await refresh(); }
    catch (err) { if (alive.current) { const message = err instanceof Error ? err.message : "Не удалось сохранить."; setError(message); setFormError(message); } }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function changeView(nextDate: string, nextPeriod = period, nextOwner = owner, nextMode = mode, nextAll = all) {
    if (busy) return;
    if (nextDate < "1900-01-01" || nextDate > "9998-12-31") return;
    if (nextDate === date && nextPeriod === period && nextOwner === owner && nextMode === mode && nextAll === all) return;
    sequence.current.value++; setResult(null); setLoading(true); setDate(nextDate); setPeriod(nextPeriod); setOwner(nextOwner); setMode(nextMode); setAll(nextAll); setError("");
  }
  function add(withAi = false) {
    setEditingId(null); setChooseOwner(false); setTargetOwner(owner); setText(withAi ? quickTitle : ""); setFormError(""); setAiOpen(withAi);
    setDrafts([{ title: quickTitle, description: "", periodType: "date", plannedDate: quickDate, plannedTime: null }]); setFormOpen(true);
  }
  function quickSave(event: FormEvent) {
    event.preventDefault();
    if (!quickTitle.trim() || !quickDate) return;
    void mutate(() => apiRequest("/api/tasks", { method: "POST", body: JSON.stringify({ ownerUserId: owner, tasks: [{ title: quickTitle.trim(), description: "", periodType: "date", plannedDate: quickDate, plannedTime: null }] }) }), () => setQuickTitle(""));
  }
  function edit(task: Task) {
    setDetail(null); setEditingId(task.id); setChooseOwner(false); setTargetOwner(owner); setFormError("");
    setDrafts([{ title: task.title, description: task.description, periodType: task.periodType, plannedDate: task.plannedDate, plannedTime: task.plannedTime }]); setFormOpen(true);
  }
  function updateDraft(index: number, change: Partial<Draft>) { setDrafts(values => values.map((value, i) => i === index ? { ...value, ...change } : value)); }
  async function parseText() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setFormError("");
    try {
      const response = await apiRequest<{ tasks: Draft[] }>("/api/tasks/parse", { method: "POST", body: JSON.stringify({ text, periodType: period, date }) });
      if (alive.current) setDrafts(response.tasks);
    } catch (err) {
      if (alive.current) { setFormError(err instanceof Error ? err.message : "Заполните вручную."); setDrafts(values => values.map((value, i) => i === 0 && !value.title ? { ...value, title: text.slice(0,500) } : value)); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void mutate(() => apiRequest(editingId ? `/api/tasks/${editingId}` : "/api/tasks", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(editingId ? drafts[0] : { ownerUserId: targetOwner, tasks: drafts }) }), () => { setFormOpen(false); if (!editingId) setQuickTitle(""); });
  }
  function toggle(task: Task) { void mutate(() => apiRequest(`/api/tasks/${task.id}/${task.completed ? "reopen" : "complete"}`, { method: "POST", body: "{}" }), () => setDetail(null)); }
  function drop(target: string) {
    const task = dragged.current; dragged.current = null; setDraggingId(null); setDropDay(null);
    if (!task || !own || task.completed || busy || task.effectiveDate === target) return;
    void mutate(() => apiRequest(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ title: task.title, description: task.description, plannedTime: task.plannedTime, periodType: "date", plannedDate: target }) }));
  }
  const cardProps = { own, busy, onDrag: (task: Task | null) => { dragged.current = task; setDraggingId(task?.id || null); setDropDay(null); }, onToggle: toggle, onDetail: (task: Task) => { setFormError(""); setDetail(task); } };
  const tasks = result?.tasks || [], days = daysOf(date, period);
  const today = result?.today || todayIn(timezone);
  const rangeLabel = period === "week" ? `${compactDateLabel(days[0]).split(" ")[0]} — ${compactDateLabel(days[days.length - 1]).split(" ")[0]}` : new Date(`${date}T12:00:00Z`).toLocaleDateString("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" });
  return <main className="app tasks-planner" aria-busy={busy}>
    <nav className="task-top-navigation" aria-label="Навигация и участник"><button className="text-button back-button" onClick={onBack}>← На главную</button><details className="task-owner-menu" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}><summary className="text-button">Чей список <span aria-hidden="true">▾</span></summary><div className="task-owner-options" role="group" aria-label="Чей список">{members.map(m => <button type="button" key={m.id} disabled={busy} aria-pressed={owner === m.id} onClick={e => { changeView(date, period, m.id); const menu = e.currentTarget.closest("details"); if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); } }}>{m.id === userId ? "Мой список" : `${m.firstName} ${m.lastName || ""}`}</button>)}</div></details></nav>
    <header className="task-page-heading"><h2 data-screen-heading tabIndex={-1}>{own ? "Мои дела" : `Дела: ${members.find(m => m.id === owner)?.firstName || "участник"}`}</h2></header>
    <form id="task-quick-add" className="task-quick-add" onSubmit={quickSave}>
      <div className="task-composer-field"><input aria-label="Название дела" placeholder="Название дела" required maxLength={500} value={quickTitle} disabled={busy} onChange={e => setQuickTitle(e.target.value)} />
      <label className="task-composer-date"><span aria-hidden="true">{quickDate ? compactDateLabel(quickDate).split(" ")[0] : "Дата"} ▾</span><input aria-label="Дата дела" type="date" required min="1900-01-01" max="9998-12-31" value={quickDate} disabled={busy} onClick={e => { try { e.currentTarget.showPicker?.(); } catch { /* Native date input fallback. */ } }} onChange={e => setQuickDate(e.target.value)} /></label></div>
      <button type="button" disabled={busy} onClick={() => add()}>Детали</button>
      <button type="button" className="task-ai-add" disabled={busy} onClick={() => add(true)}>Добавить с AI</button>
      <button type="submit" className="primary task-add" disabled={busy || !quickTitle.trim()}>Добавить</button>
    </form>
    {!own && <p className="muted task-permissions">Можно просматривать и добавлять дела. Изменяет и выполняет их владелец списка.</p>}
    <section className="task-period-panel" aria-label="Период и дата">
    <nav className="task-periods" aria-label="Период дел">{(["date", "week", "month"] as Period[]).map(p => <button key={p} disabled={busy} aria-pressed={p === period} onClick={() => changeView(p === "date" ? today : date, p)}>{p === "date" ? "Сегодня" : periodNames[p]}</button>)}</nav>
    {period !== "month" && <div className="task-date-navigation" onTouchStart={e => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }} onTouchEnd={e => { const start = touch.current; touch.current = null; if (!start || busy) return; const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y; if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) changeView(movePeriod(date, period, dx < 0 ? 1 : -1)); }}>
      <button aria-label="Предыдущий период" disabled={busy} onClick={() => changeView(movePeriod(date, period, -1))}>←</button>
      {period === "week" ? <p className="task-period-range">{rangeLabel}</p> : <label className="task-date-picker"><span aria-hidden="true">{compactDateLabel(date)}</span><input aria-label={`Выбранная дата: ${compactDateLabel(date)}`} type="date" min="1900-01-01" max="9998-12-31" value={date} disabled={busy} onClick={event => { try { event.currentTarget.showPicker?.(); } catch { /* Native input remains available. */ } }} onChange={e => { if (e.target.value) changeView(e.target.value); }} /></label>}
      <button aria-label="Следующий период" disabled={busy} onClick={() => changeView(movePeriod(date, period, 1))}>→</button>
    </div>}
    {period === "month" && <p className="task-period-range">{rangeLabel}</p>}
    </section>
    <section className="task-results" aria-label="Список задач">
    <div className="task-results-heading"><h3>Задачи</h3><details className="task-status-filter task-owner-menu" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary aria-label={`Статус задач: ${all ? "Все" : "Невыполненные"}`} aria-disabled={busy} onClick={e => { if (busy) e.preventDefault(); }}>{all ? "Все" : "Невыполненные"} <span aria-hidden="true">▾</span></summary>
      <div className="task-owner-options" role="group" aria-label="Статус задач">{[{ value: false, label: "Невыполненные" }, { value: true, label: "Все" }].map(option => <button type="button" key={option.label} disabled={busy} aria-pressed={all === option.value} onClick={e => { changeView(date, period, owner, mode, option.value); const menu = e.currentTarget.closest("details"); if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); } }}>{option.label}</button>)}</div>
    </details></div>
    {period !== "date" && <div className="task-date-modes" role="group" aria-label="Дела с датой или без даты"><button disabled={busy} aria-pressed={mode === "days"} onClick={() => changeView(date, period, owner, "days")}>По дням</button><button disabled={busy} aria-pressed={mode === "undated"} onClick={() => changeView(date, period, owner, "undated")}>Без даты</button></div>}
    {error && <ErrorNotice message={error} retry={() => void refresh()} />}{notice && <p className="sr-only" role="status">{notice}</p>}
    {loading ? <Loading /> : period === "month" && mode === "days" ? <>
      <div className="task-calendar" aria-label="Календарь месяца">{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(d => <span key={d}>{d}</span>)}{Array.from({ length: (new Date(`${days[0]}T12:00:00Z`).getUTCDay() + 6) % 7 }, (_, i) => <span key={`blank${i}`} />)}{days.map(day => <button key={day} disabled={busy} aria-label={`${dayLabel(day)}, дел: ${tasks.filter(t => t.effectiveDate === day).length}`} aria-pressed={date === day} onClick={() => setDate(day)} onDragOver={e => e.preventDefault()} onDrop={() => drop(day)}>{Number(day.slice(8))}<small>{tasks.filter(t => t.effectiveDate === day).length || "·"}</small></button>)}</div>
      <h3 className="task-day-heading">{dayLabel(date)}</h3>{tasks.some(t => t.effectiveDate === date) ? <TaskCards tasks={tasks.filter(t => t.effectiveDate === date)} {...cardProps} /> : <TaskEmpty>На этот день дел нет.</TaskEmpty>}
    </> : period === "week" && mode === "days" ? <div className={`task-week${draggingId ? " task-dragging" : ""}`}>{days.map(day => <section key={day} data-drop-day={day} className={dropDay === day ? "task-drop-active" : ""} onDragOver={e => { if (dragged.current && own && !busy) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropDay(day); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDay(null); }} onDrop={e => { e.preventDefault(); drop(day); }}><h3 className="task-day-heading">{dayLabel(day)}</h3>{tasks.some(t => t.effectiveDate === day) ? <TaskCards tasks={tasks.filter(t => t.effectiveDate === day)} {...cardProps} /> : <p className="task-day-empty">Нет дел</p>}</section>)}</div> : tasks.length ? <TaskCards tasks={tasks} {...cardProps} /> : <TaskEmpty>Пока нет дел.</TaskEmpty>}
    </section>
    {formOpen && <Modal title={editingId ? "Редактировать / перенести" : "Добавить дело"} busy={busy} close={() => setFormOpen(false)}>
      {!editingId && aiOpen && <div className="task-ai"><label htmlFor="task-phrase">Опишите одно или несколько дел</label><textarea id="task-phrase" maxLength={4000} value={text} disabled={busy} onChange={e => setText(e.target.value)} placeholder="Позвонить врачу завтра в 14:30" /><button type="button" disabled={busy || !text.trim()} onClick={() => void parseText()}>Разобрать с AI</button><p className="muted">Проверьте результат перед сохранением или заполните поля вручную.</p></div>}
      {formError && <ErrorNotice message={formError} />}
      <form onSubmit={save}>
        {chooseOwner && <label>Кому добавить<PastelSelect label="Кому добавить" disabled={busy} value={targetOwner} onChange={setTargetOwner} options={members.map(m => ({ value: m.id, label: `${m.firstName} ${m.lastName || ""}` }))} /></label>}
        {drafts.map((draft, i) => <fieldset key={i} disabled={busy}><legend>{drafts.length > 1 ? `Дело ${i + 1}` : "Данные дела"}</legend>
          <label>Название<input required maxLength={500} value={draft.title} onChange={e => updateDraft(i, { title: e.target.value })} /></label>
          <label>Описание<textarea maxLength={4000} value={draft.description} onChange={e => updateDraft(i, { description: e.target.value })} /></label>
          <label>Период<PastelSelect label="Период" disabled={busy} value={draft.periodType} onChange={value => { const p = value as Period; updateDraft(i, { periodType: p, plannedDate: startOf(draft.plannedDate || today, p), plannedTime: p === "date" ? draft.plannedTime : null }); }} options={Object.entries(periodNames).map(([p, label]) => ({ value: p, label: label + (p !== "date" ? " без точного дня" : "") }))} /></label>
          <label>{draft.periodType === "date" ? "Дата" : "Дата внутри нужного периода"}<input type="date" required min="1900-01-01" max="9998-12-31" value={draft.plannedDate} onChange={e => updateDraft(i, { plannedDate: e.target.value ? startOf(e.target.value, draft.periodType) : "" })} /></label>
          {draft.periodType === "date" && <label>Время (необязательно)<input type="time" value={draft.plannedTime || ""} onChange={e => updateDraft(i, { plannedTime: e.target.value || null })} /></label>}
          {drafts.length > 1 && <button type="button" onClick={() => setDrafts(values => values.filter((_, index) => index !== i))}>Убрать из добавления</button>}
        </fieldset>)}
        <button className="primary" disabled={busy || drafts.some(d => !d.title.trim())}>{busy ? "Сохраняем…" : "Сохранить"}</button>
        <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>Отмена</button>
      </form>
    </Modal>}
    {detail && <Modal title={detail.title} busy={busy} close={() => setDetail(null)}>
      <p className="task-description">{detail.description || "Без описания"}</p><p>{periodNames[detail.periodType]}: {detail.plannedDate} {detail.plannedTime}</p>
      <p className="muted">Первоначальный срок: {periodNames[detail.originalPeriodType]} {detail.originalPlannedDate}</p>
      <p className="muted">Добавил(а) {detail.author}, {new Date(detail.createdAt * 1000).toLocaleString("ru-RU", { timeZone: timezone })}</p>
      {detail.completedAt && <p>Выполнено {new Date(detail.completedAt * 1000).toLocaleString("ru-RU", { timeZone: timezone })}</p>}
      {detail.overdue > 0 && <p className="task-overdue-label">{overdueLabel(detail)}</p>}
      {error && <ErrorNotice message={error} />}
      {own && <div className="task-detail-actions"><button disabled={busy} onClick={() => toggle(detail)}>{detail.completed ? "Вернуть в активные" : "Выполнить"}</button><button disabled={busy} onClick={() => edit(detail)}>Редактировать / Перенести</button><button className="danger" disabled={busy} onClick={() => { setDeleting(detail); setDetail(null); }}>Удалить</button></div>}
    </Modal>}
    {deleting && <ConfirmDialog title="Удалить дело?" confirmLabel="Удалить" busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void mutate(() => apiRequest(`/api/tasks/${deleting.id}`, { method: "DELETE", body: "{}" }), () => setDeleting(null))}><p>{deleting.title}</p>{error && <ErrorNotice message={error} />}</ConfirmDialog>}
  </main>;
}
