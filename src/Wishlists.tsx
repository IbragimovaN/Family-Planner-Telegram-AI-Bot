import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "./api/http";
import { navigate, type Route } from "./navigation";
import { ConfirmDialog, Empty, ErrorNotice, Loading } from "./components/States";
import FormDialog from "./components/FormDialog";
import PastelSelect from "./components/PastelSelect";
import { PencilIcon, TrashIcon } from "./components/ShoppingIcons";

type Profile = { id: string; name: string; canManage: boolean; itemCount: number; completedCount: number };
type Wish = { id: string; title: string; url: string | null; note: string | null; priceMinor: number | null; currency: string | null; completed: boolean; author: string; completedBy: string | null };
type Detail = { profile: Profile; items: Wish[] };
type Draft = { id?: string; title: string; url: string; note: string; price: string; currency: string };
const blankDraft = (title = ""): Draft => ({ title, url: "", note: "", price: "", currency: "RUB" });
const money = (item: Wish) => item.priceMinor === null ? "" : new Intl.NumberFormat("ru-RU", { style: "currency", currency: item.currency || "RUB", maximumFractionDigits: 2 }).format(item.priceMinor / 100);
// Only HTTP(S) links are rendered, including for any previously stored records.
function safeLink(value: string | null) { try { const url = new URL(value || ""); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } }

export default function Wishlists({ route, back }: { route: Route; back: () => void }) {
  const profileId = route.startsWith("wishlists/") ? route.split("/")[1] : null;
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [name, setName] = useState(""), [title, setTitle] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rename, setRename] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: "profile" | "item"; id: string; name: string } | null>(null);
  const [formError, setFormError] = useState("");
  const sequence = useRef({ value: 0 }), inFlight = useRef(false), alive = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current.value;
    try {
      if (profileId) {
        const data = await apiRequest<Detail>(`/api/wishlists/${profileId}`, { signal });
        if (alive.current && request === sequence.current.value && !signal?.aborted) setDetail(data);
      } else {
        const data = await apiRequest<{ profiles: Profile[] }>("/api/wishlists", { signal });
        if (alive.current && request === sequence.current.value && !signal?.aborted) setProfiles(data.profiles);
      }
      if (alive.current && request === sequence.current.value && !signal?.aborted) setError("");
    } catch (err) {
      if (alive.current && request === sequence.current.value && !signal?.aborted) setError(err instanceof Error ? err.message : "Не удалось загрузить вишлисты.");
    } finally { if (alive.current && request === sequence.current.value && !signal?.aborted) setLoading(false); }
  }, [profileId]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(), activeRequest = sequence.current;
    const update = () => { if (!document.hidden && !inFlight.current) void refresh(controller.signal); };
    update(); const timer = window.setInterval(update, 15000);
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { alive.current = false; activeRequest.value++; controller.abort(); clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [refresh]);
  async function mutate(work: () => Promise<unknown>, done?: () => void) {
    if (inFlight.current) return;
    inFlight.current = true; sequence.current.value++; setBusy(true); setError(""); setFormError("");
    try {
      await work(); if (!alive.current) return;
      done?.(); setNotice("Изменения сохранены.");
      if (alive.current) await refresh();
    } catch (err) {
      if (alive.current) { const message = err instanceof Error ? err.message : "Не удалось сохранить."; setError(message); setFormError(message); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function createProfile(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void mutate(async () => {
      const result = await apiRequest<{ id: string }>("/api/wishlists", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      if (alive.current) navigate(`wishlists/${result.id}`);
    });
  }
  function quickAdd(event: FormEvent) {
    event.preventDefault(); if (!title.trim()) return;
    void mutate(() => apiRequest(`/api/wishlists/${profileId}/items`, { method: "POST", body: JSON.stringify({ title: title.trim() }) }), () => setTitle(""));
  }
  function openDraft(item?: Wish) {
    setFormError("");
    setDraft(item ? { id: item.id, title: item.title, url: item.url || "", note: item.note || "", price: item.priceMinor === null ? "" : (item.priceMinor / 100).toFixed(2).replace(".", ","), currency: item.currency || "RUB" } : blankDraft(title));
  }
  function saveDraft(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    const amount = draft.price.trim().replace(",", ".");
    if (amount && !/^\d{1,10}(\.\d{1,2})?$/.test(amount)) { setFormError("Укажите неотрицательную цену, не более двух знаков после запятой."); return; }
    if (draft.url.trim() && !safeLink(draft.url.trim())) { setFormError("Ссылка должна начинаться с https:// или http://."); return; }
    const [whole, fraction = ""] = amount.split(".");
    const priceMinor = amount ? Number(whole) * 100 + Number(fraction.padEnd(2, "0")) : null;
    if (priceMinor !== null && priceMinor > 999999999999) { setFormError("Слишком большая цена."); return; }
    const body = { title: draft.title.trim(), url: draft.url.trim() || null, note: draft.note.trim() || null, priceMinor, currency: priceMinor === null ? null : draft.currency };
    void mutate(() => apiRequest(draft.id ? `/api/wishlist-items/${draft.id}` : `/api/wishlists/${profileId}/items`, { method: draft.id ? "PATCH" : "POST", body: JSON.stringify(body) }), () => { setDraft(null); if (!draft.id) setTitle(""); });
  }
  function remove() {
    if (!confirmation) return;
    const target = confirmation;
    void mutate(() => apiRequest(target.kind === "profile" ? `/api/wishlists/${target.id}` : `/api/wishlist-items/${target.id}`, { method: "DELETE", body: "{}" }), () => {
      setConfirmation(null);
      if (target.kind === "profile") navigate("wishlists", true);
    });
  }
  const items = detail?.items.filter(item => showAll || !item.completed) || [];
  return <section className="shopping-screen shopping-viewport wishlists-screen" aria-busy={busy}>
    <div className="shopping-navigation"><button type="button" className="text-button back-button" disabled={busy} onClick={back}>← {profileId ? "К вишлистам" : "На главную"}</button>
      {detail?.profile.canManage && <button type="button" className="text-button wishlist-rename" aria-label="Переименовать вишлист" disabled={busy} onClick={() => { setFormError(""); setRename(detail.profile.name); }}><PencilIcon /></button>}
    </div>
    <header className="wishlist-heading"><h1 data-screen-heading tabIndex={-1}>{profileId ? detail?.profile.name || "Вишлист" : "Вишлисты"}</h1><p className="muted">{profileId ? "Желания, которые можно исполнить вместе" : "Общие списки желаний вашей семьи"}</p></header>
    {error && <ErrorNotice message={error} retry={() => void refresh()} />}
    {notice && <p className="sr-only" role="status">{notice}</p>}
    {loading ? <Loading /> : !profileId ? <>
      <form className="wishlist-quick-add" onSubmit={createProfile}><label className="sr-only" htmlFor="wishlist-name">Чей вишлист</label><input id="wishlist-name" placeholder="Чей вишлист? Введите имя" value={name} maxLength={100} required disabled={busy} onChange={e => setName(e.target.value)} /><button className="primary" disabled={busy || !name.trim()}>Создать</button></form>
      <div className="shopping-list-scroll" role="region" aria-label="Вишлисты семьи" tabIndex={0}>
        {profiles.length ? <ul className="wishlist-profiles">{profiles.map(p => <li key={p.id}><button type="button" disabled={busy} onClick={() => navigate(`wishlists/${p.id}`)}><span className="wishlist-initial" aria-hidden="true">{Array.from(p.name)[0]?.toLocaleUpperCase("ru-RU")}</span><span className="wishlist-profile-info"><strong>{p.name}</strong><small>Желаний: {p.itemCount} · Исполнено: {p.completedCount}</small></span><span aria-hidden="true">›</span></button></li>)}</ul> : <Empty>Создайте первый вишлист — достаточно имени.</Empty>}
      </div>
    </> : detail && <>
      <form className="wishlist-quick-add wishlist-item-add" onSubmit={quickAdd}><label className="sr-only" htmlFor="wish-title">Название желания</label><input id="wish-title" placeholder="Добавить желание" value={title} maxLength={200} required disabled={busy} onChange={e => setTitle(e.target.value)} /><button type="button" disabled={busy} onClick={() => openDraft()}>Детали</button><button className="primary" disabled={busy || !title.trim()}>Добавить</button></form>
      {detail.items.length > 0 && <button type="button" className="purchase-filter-toggle" role="switch" aria-checked={!showAll} disabled={busy} onClick={() => setShowAll(value => !value)}><span>Скрывать исполненные</span><span className="purchase-switch-track" aria-hidden="true"><span /></span></button>}
      <div className="shopping-list-scroll" role="region" aria-label="Желания" tabIndex={0}>
        {!items.length ? <Empty>{detail.items.length ? "Все желания исполнены. Выключите фильтр, чтобы увидеть их." : "Здесь появятся желания."}</Empty> : <ul className="shopping-items wishlist-items">{items.map(item => <li key={item.id} className={item.completed ? "completed-task" : ""}>
          <label className="purchase-check"><input type="checkbox" checked={item.completed} disabled={busy} aria-label={`${item.completed ? "Вернуть" : "Исполнено"}: ${item.title}`} onChange={() => void mutate(() => apiRequest(`/api/wishlist-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ completed: !item.completed }) }))} /></label>
          <div className="wishlist-item-content"><span className={`purchase-title-text${item.completed ? " completed" : ""}`} title={item.title}>{item.title}</span>
            {(item.priceMinor !== null || safeLink(item.url)) && <div className="wishlist-item-meta">{item.priceMinor !== null && <small>{money(item)}</small>}{safeLink(item.url) && <a href={safeLink(item.url)} target="_blank" rel="noopener noreferrer">Ссылка ↗</a>}</div>}
            {item.note && <p className="wishlist-note">{item.note}</p>}
          </div>
          <div className="wishlist-item-actions"><button type="button" className="icon-button" aria-label={`Редактировать: ${item.title}`} disabled={busy} onClick={() => openDraft(item)}><PencilIcon /></button><button type="button" className="icon-button icon-delete" aria-label={`Удалить: ${item.title}`} disabled={busy} onClick={() => { setFormError(""); setConfirmation({ kind: "item", id: item.id, name: item.title }); }}><TrashIcon /></button></div>
        </li>)}</ul>}
      </div>
      {detail.profile.canManage && <button type="button" className="danger purchase-list-action" disabled={busy} onClick={() => { setFormError(""); setConfirmation({ kind: "profile", id: detail.profile.id, name: detail.profile.name }); }}>Удалить вишлист</button>}
    </>}
    {draft && <FormDialog title={draft.id ? "Детали желания" : "Новое желание"} busy={busy} close={() => setDraft(null)}><form onSubmit={saveDraft}>
      {formError && <ErrorNotice message={formError} />}
      <label htmlFor="wish-edit-title">Название</label><input id="wish-edit-title" autoFocus required maxLength={200} value={draft.title} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} />
      <label htmlFor="wish-url">Ссылка <small>Необязательно</small></label><input id="wish-url" type="url" placeholder="https://" maxLength={2048} value={draft.url} disabled={busy} onChange={e => setDraft({ ...draft, url: e.target.value })} />
      <label htmlFor="wish-note">Заметка</label><textarea id="wish-note" rows={3} maxLength={2000} value={draft.note} disabled={busy} onChange={e => setDraft({ ...draft, note: e.target.value })} />
      <div className="wishlist-price-fields"><label>Цена<input aria-label="Цена" inputMode="decimal" placeholder="Необязательно" value={draft.price} disabled={busy} onChange={e => setDraft({ ...draft, price: e.target.value })} /></label><label>Валюта<PastelSelect label="Валюта" value={draft.currency} disabled={busy} onChange={currency => setDraft({ ...draft, currency })} options={[{ value: "RUB", label: "₽ RUB" }, { value: "USD", label: "$ USD" }, { value: "EUR", label: "€ EUR" }]} /></label></div>
      {draft.id && <p className="muted">Добавил(а): {detail?.items.find(i => i.id === draft.id)?.author}</p>}
      <div className="button-row"><button type="button" disabled={busy} onClick={() => setDraft(null)}>Отмена</button><button className="primary" disabled={busy || !draft.title.trim()}>Сохранить</button></div>
    </form></FormDialog>}
    {rename !== null && <FormDialog title="Чей вишлист" busy={busy} close={() => setRename(null)}><form onSubmit={e => { e.preventDefault(); void mutate(() => apiRequest(`/api/wishlists/${profileId}`, { method: "PATCH", body: JSON.stringify({ name: rename.trim() }) }), () => setRename(null)); }}>
      {formError && <ErrorNotice message={formError} />}<label htmlFor="wishlist-rename">Имя</label><input id="wishlist-rename" autoFocus required maxLength={100} value={rename} disabled={busy} onChange={e => setRename(e.target.value)} /><div className="button-row"><button type="button" disabled={busy} onClick={() => setRename(null)}>Отмена</button><button className="primary" disabled={busy || !rename.trim()}>Сохранить</button></div>
    </form></FormDialog>}
    {confirmation && <ConfirmDialog title={confirmation.kind === "profile" ? "Удалить вишлист?" : "Удалить желание?"} confirmLabel="Удалить" busy={busy} onCancel={() => setConfirmation(null)} onConfirm={remove}><p>{confirmation.name}</p>{confirmation.kind === "profile" && <p>Все желания этого вишлиста будут удалены. Это действие нельзя отменить.</p>}{formError && <ErrorNotice message={formError} />}</ConfirmDialog>}
  </section>;
}
