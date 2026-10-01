import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import App from "./App";
import WriteAccess from "./WriteAccess";
import { apiRequest } from "./api/http";

type Family = { id: string; name: string; timezone: string; role: "owner" | "member" };
type Member = { id: string; firstName: string; lastName: string | null; role: "owner" | "member" };
type Invitation = { id: string; createdAt: number; expiresAt: number; revokedAt: number | null };
type NewInvitation = { invitation: Invitation; token: string; url: string | null };

function invitationToken(value: string): string {
  const text = value.trim();
  let parameter = text;
  if (text.startsWith("https://") || text.startsWith("http://")) {
    try {
      const url = new URL(text);
      parameter = url.searchParams.get("startapp") || url.searchParams.get("invite") || "";
    } catch { return ""; }
  }
  parameter = parameter.replace(/^invite_/, "");
  return /^[A-Za-z0-9_-]{43}$/.test(parameter) ? parameter : "";
}
function initialInvitation() {
  const params = new URLSearchParams(window.location.search);
  const init = new URLSearchParams(window.Telegram?.WebApp.initData || "");
  return invitationToken(params.get("invite") || params.get("tgWebAppStartParam") || init.get("start_param") || "");
}

type Props = { user: { id: string; firstName: string; lastName: string | null }; dev: boolean; onLogout: () => Promise<void>; logoutBusy: boolean; authMessage?: string };

export default function FamilyGate({ user, dev, onLogout, logoutBusy, authMessage }: Props) {
  const [family, setFamily] = useState<Family | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitation, setInvitation] = useState<NewInvitation | null>(null);
  const [joinText, setJoinText] = useState(initialInvitation);
  const [inviteScreen, setInviteScreen] = useState(() => Boolean(initialInvitation()));
  const [preview, setPreview] = useState<{ token: string; name?: string; membership?: "none" | "same" | "other"; error?: string } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const tokenToPreview = invitationToken(joinText);
  useEffect(() => {
    if (!tokenToPreview) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiRequest<{ name: string; membership: "none" | "same" | "other" }>("/api/family/invitation-preview", {
        method: "POST", body: JSON.stringify({ token: tokenToPreview }), signal: controller.signal,
      }).then(result => { if (!controller.signal.aborted) setPreview({ token: tokenToPreview, ...result }); })
        .catch(error => { if (!controller.signal.aborted) setPreview({ token: tokenToPreview, error: error instanceof Error ? error.message : "Не удалось проверить приглашение." }); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [tokenToPreview, previewAttempt, family?.id]);
  const checkedInvite = preview?.token === tokenToPreview ? preview : null;
  const [onboarding, setOnboarding] = useState<"create" | "join">(() => initialInvitation() ? "join" : "create");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"home" | "family" | "tasks">("home");
  const [confirmation, setConfirmation] = useState<{ kind: "member" | "invitation"; id: string; name: string } | null>(null);
  const sequence = useRef({ value: 0 });
  const [clock, setClock] = useState(() => Date.now());
  const inFlight = useRef(false);
  const confirmationPanel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement;
    confirmationPanel.current?.focus();
    confirmationPanel.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [confirmation]);

  const refresh = useCallback(async () => {
    const request = ++sequence.current.value;
    try {
      const result = await apiRequest<{ family: Family | null }>("/api/family");
      if (request !== sequence.current.value) return;
      setClock(Date.now());
      setFamily(result.family);
      if (!result.family) { setMembers([]); setInvitations([]); setInvitation(null); return; }
      const [people, links] = await Promise.all([
        apiRequest<{ members: Member[] }>("/api/family/members"),
        result.family.role === "owner" ? apiRequest<{ invitations: Invitation[] }>("/api/family/invitations") : Promise.resolve({ invitations: [] }),
      ]);
      if (request !== sequence.current.value) return;
      setMembers(people.members); setInvitations(links.invitations);
    } catch (err) {
      if (request === sequence.current.value) setError(err instanceof Error ? err.message : "Не удалось загрузить семью.");
    } finally { if (request === sequence.current.value) setLoading(false); }
  }, []);

  useEffect(() => {
    const activeSequence = sequence.current;
    const onFocus = () => { if (!document.hidden && !inFlight.current) void refresh(); };
    const initialLoad = window.setTimeout(onFocus, 0);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, 15000);
    return () => { activeSequence.value++; window.clearTimeout(initialLoad); window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [refresh]);

  async function action(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось выполнить действие."); await refresh(); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      await apiRequest("/api/families", { method: "POST", body: JSON.stringify({ name: data.get("name") }) });
      setNotice("Семья создана. Теперь можно пригласить близких.");
    });
  }
  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = invitationToken(joinText);
    if (!token) { setError("Вставьте ссылку или код приглашения целиком."); return; }
    void action(async () => {
      await apiRequest("/api/family/join", { method: "POST", body: JSON.stringify({ token }) });
      setInviteScreen(false); setView("home");
      setJoinText(""); setNotice("Вы присоединились к семье.");
      const url = new URL(window.location.href);
      url.searchParams.delete("invite"); url.searchParams.delete("tgWebAppStartParam");
      window.history.replaceState(null, "", url);
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      await apiRequest("/api/family", { method: "PATCH", body: JSON.stringify({ name: data.get("name"), timezone: data.get("timezone") }) });
      setNotice("Настройки сохранены.");
    });
  }
  async function confirm() {
    if (!confirmation) return;
    const target = confirmation;
    await action(async () => {
      const path = target.kind === "member" ? "members" : "invitations";
      await apiRequest(`/api/family/${path}/${encodeURIComponent(target.id)}`, { method: "DELETE", body: "{}" });
      if (target.kind === "invitation" && invitation?.invitation.id === target.id) setInvitation(null);
      setConfirmation(null); setNotice(target.kind === "member" ? "Участник удалён из семьи." : "Приглашение отозвано.");
    });
  }

  if (loading) return <main className="app"><p role="status">Загружаем семью…</p></main>;
  return <>
    <header className="auth-bar">
      <div><strong>{user.firstName} {user.lastName || ""}</strong>
        {family && !inviteScreen ? <details className="account-menu family-menu"><summary>{family.name}</summary><button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setView(view === "family" ? "home" : "family"); setConfirmation(null); }}>{view === "family" ? "На главную" : family.role === "owner" ? "Настройки семьи" : "Участники семьи"}</button></details> : dev && <small>Тестовый профиль</small>}
      </div>
      <details className="account-menu"><summary>Аккаунт</summary><button type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? "Выходим…" : "Выйти из аккаунта"}</button></details>
      {authMessage && <p role="alert">{authMessage}</p>}
    </header>
    <section className="app family-screen" aria-label="Семья">
      <p className="eyebrow">Family Planner</p>
      {(!family || inviteScreen || view === "family") && <h1>{inviteScreen ? "Приглашение в семью" : family ? family.name : onboarding === "join" ? "Вас пригласили в семью" : "Всё начинается с семьи"}</h1>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {tokenToPreview && !checkedInvite && <p role="status">Проверяем приглашение…</p>}
      {checkedInvite?.error && <><p role="alert">{checkedInvite.error}</p><button onClick={() => { setPreview(null); setPreviewAttempt(value => value + 1); }}>Проверить снова</button></>}
      {checkedInvite?.name && <p>Приглашение в семью «{checkedInvite.name}»</p>}
      {error && <button type="button" disabled={busy} onClick={() => { setError(""); void refresh(); }}>Обновить данные</button>}
      {!family && onboarding === "create" && <>
        <p>Создайте общее пространство для вас и ваших близких.</p>
        <form onSubmit={create}>
          <label htmlFor="family-name">Название семьи</label>
          <input id="family-name" name="name" maxLength={100} required placeholder="Например, Наша семья" disabled={busy} />
          <button className="primary" disabled={busy}>{busy ? "Создаём…" : "Создать семью"}</button>
        </form>
        <button className="text-button" disabled={busy} onClick={() => { setError(""); setOnboarding("join"); }}>У меня есть приглашение</button>
      </>}
      {!family && onboarding === "join" && <>
        <p>Присоединитесь, чтобы планировать дела вместе с близкими.</p>
        <form onSubmit={join}>
        {!initialInvitation() && <>
        <label htmlFor="family-invite">Ссылка или код приглашения</label>
        <input id="family-invite" value={joinText} onChange={event => setJoinText(event.target.value)} required disabled={busy} autoComplete="off" />
        </>}
        <button className="primary" disabled={busy || !checkedInvite?.name || checkedInvite.membership !== "none"}>{busy ? "Присоединяемся…" : "Вступить в семью"}</button>
      </form>
      {!inviteScreen && <button className="text-button" disabled={busy} onClick={() => { setError(""); setOnboarding("create"); }}>Создать свою семью</button>}
      </>}
      {family && inviteScreen && <>
        <p>{checkedInvite?.membership === "same" ? `Вы уже участник семьи «${family.name}».` : checkedInvite?.membership === "other" ? `Вы состоите в другой семье — «${family.name}». Вступление в несколько семей недоступно.` : `Ваша текущая семья — «${family.name}».`}</p>
        <button className="primary" onClick={() => { setInviteScreen(false); setJoinText(""); setView("home"); const url = new URL(window.location.href); url.searchParams.delete("invite"); url.searchParams.delete("tgWebAppStartParam"); window.history.replaceState(null, "", url); }}>Открыть свою семью</button>
      </>}
      {family && !inviteScreen && <>
        {view === "home" && <nav className="home-sections" aria-label="Разделы приложения">
          <button onClick={() => setView("tasks")}>Дела</button>
          <button disabled>Список покупок<small>Скоро</small></button>
          <button disabled>Вишлисты<small>Скоро</small></button>
        </nav>}
        {view === "tasks" && <><button className="text-button back-button" onClick={() => setView("home")}>← На главную</button><App /></>}
        {view === "family" && <>
          <div className="profile-card"><div><strong>{user.firstName} {user.lastName || ""}</strong><p className="muted">{family.role === "owner" ? "Вы управляете этой семьёй" : "Вы участник этой семьи"}</p><small>{family.role === "owner" ? "Владелец" : "Участник"}</small></div><img src="/svg-avatar.svg" alt="" width="72" height="72" /></div>
          <div className="section-caption">{family.role === "owner" ? "Участники и настройки" : "Участники семьи"}</div>
          <h2>Участники семьи</h2>
          <ul className="family-list">{members.map(member => <li key={member.id}>
            <span><strong>{member.firstName} {member.lastName || ""}</strong><small>{member.role === "owner" ? "Владелец" : "Участник"}</small></span>
            {family.role === "owner" && member.role !== "owner" && <details><summary>Управление участником</summary><button className="danger" type="button" disabled={busy} onClick={() => setConfirmation({ kind: "member", id: member.id, name: member.firstName })}>Удалить участника</button></details>}
          </li>)}</ul>
          {family.role === "owner" && <>
            <details className="settings-panel"><summary>Настройки семьи</summary>
            <form key={`${family.id}:${family.name}:${family.timezone}`} onSubmit={save}>
              <label htmlFor="settings-name">Название</label>
              <input id="settings-name" name="name" defaultValue={family.name} maxLength={100} required disabled={busy} />
              <label htmlFor="settings-timezone">Часовой пояс</label>
              <input id="settings-timezone" name="timezone" defaultValue={family.timezone} list="timezones" required disabled={busy} />
              <datalist id="timezones">{["Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Asia/Vladivostok", "UTC"].map(zone => <option key={zone} value={zone} />)}</datalist>
              <p className="muted">Неделя начинается в понедельник.</p>
              <button className="primary" disabled={busy}>Сохранить настройки</button>
            </form>
            </details>
            <section className="invite-panel">
            <h2>Приглашения</h2>
            <p>Ссылка действует 7 дней и подходит для нескольких человек.</p>
            <button className={invitation ? "" : "primary"} type="button" disabled={busy} onClick={() => void action(async () => {
              setInvitation(await apiRequest<NewInvitation>("/api/family/invitations", { method: "POST", body: "{}" }));
            })}>Создать приглашение</button>
            {invitation && <div className="invitation-result">
              <label htmlFor="new-invite">{invitation.url ? "Ссылка приглашения" : "Код приглашения"}</label>
              <input id="new-invite" readOnly value={invitation.url || invitation.token} onFocus={event => event.target.select()} />
              {!dev && invitation.url && <button className="primary" type="button" onClick={() => {
                const shareUrl = `https://t.me/share/url?${new URLSearchParams({ url: invitation.url!, text: `Присоединяйтесь к семье «${family.name}» в Family Planner` })}`;
                try {
                  const app = window.Telegram?.WebApp;
                  if (app?.openTelegramLink) app.openTelegramLink(shareUrl);
                  else window.open(shareUrl, "_blank", "noopener,noreferrer");
                } catch { setError("Не удалось открыть Telegram. Скопируйте ссылку вручную."); }
              }}>Поделиться в Telegram</button>}
              <button className={dev ? "primary" : ""} type="button" onClick={async () => {
                try { await navigator.clipboard.writeText(invitation.url || invitation.token); setNotice("Приглашение скопировано."); }
                catch { setError("Выделите и скопируйте приглашение из поля вручную."); }
              }}>Скопировать</button>
              <p>Сохраните ссылку сейчас: после обновления страницы она больше не отображается.</p>
            </div>}
            {invitations.length > 0 && <details><summary>Управление ссылками · {invitations.length}</summary><ul className="family-list">{invitations.map(link => <li key={link.id}>
              <span>До {new Date(link.expiresAt * 1000).toLocaleString("ru-RU", { timeZone: family.timezone })} · {link.revokedAt ? "Отозвано" : link.expiresAt * 1000 <= clock ? "Истекло" : "Действует"}</span>
              {!link.revokedAt && link.expiresAt * 1000 > clock && <button className="danger" type="button" disabled={busy} onClick={() => setConfirmation({ kind: "invitation", id: link.id, name: "приглашение" })}>Отозвать</button>}
            </li>)}</ul></details>}
            </section>
          </>}
          {!dev && <WriteAccess />}
        </>}
      </>}
      {confirmation && <div ref={confirmationPanel} tabIndex={-1} role="alertdialog" aria-labelledby="confirm-title" className="family-confirm" onKeyDown={event => { if (event.key === "Escape" && !busy) setConfirmation(null); }}>
        <h2 id="confirm-title">{confirmation.kind === "member" ? `Удалить участника «${confirmation.name}»?` : "Отозвать приглашение?"}</h2>
        <p>{confirmation.kind === "member" ? "Участник потеряет доступ к семье. По действующей ссылке он сможет вступить снова." : "По этой ссылке больше нельзя будет вступить в семью."}</p>
        <button className="danger" type="button" disabled={busy} onClick={() => void confirm()}>{confirmation.kind === "member" ? "Удалить участника" : "Отозвать приглашение"}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Отмена</button>
      </div>}
    </section>
  </>;
}
