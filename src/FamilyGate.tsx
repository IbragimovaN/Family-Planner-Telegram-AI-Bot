import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Tasks from "./Tasks";
import Wishlists from "./Wishlists";
import PastelSelect from "./components/PastelSelect";
import WriteAccess from "./WriteAccess";
import { apiRequest } from "./api/http";
import { navigate, useNavigation, useTelegramBack, type Route } from "./navigation";
import { ConfirmDialog, Loading } from "./components/States";
import Shopping from "./Shopping";

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

type Props = { user: { id: string; firstName: string; lastName: string | null; photoUrl?: string | null }; dev: boolean; onLogout: () => Promise<void>; logoutBusy: boolean; authMessage?: string };

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
  const [editingFamily, setEditingFamily] = useState(false);
  const { route: view, back } = useNavigation();
  function setView(route: Route) { setNotice(""); setError(""); navigate(route); }
  const [confirmation, setConfirmation] = useState<{ kind: "member" | "invitation"; id: string; name: string } | null>(null);
  const sequence = useRef({ value: 0 });
  const [clock, setClock] = useState(() => Date.now());
  const inFlight = useRef(false);
  const goBack = useCallback(() => {
    if (busy) return;
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (dialog) { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); return; }
    if (document.querySelector('.shopping-screen[aria-busy="true"]')) return;
    if (confirmation) { setConfirmation(null); return; }
    if (inviteScreen) {
      setInviteScreen(false); setJoinText(""); setOnboarding("create");
      const url = new URL(window.location.href);
      url.searchParams.delete("invite"); url.searchParams.delete("tgWebAppStartParam");
      window.history.replaceState(null, "", url);
      navigate("home", true);
    } else if (!family) setOnboarding("create");
    else back();
  }, [busy, confirmation, inviteScreen, family, back]);
  useTelegramBack(Boolean(confirmation || inviteScreen || (family ? view !== "home" : onboarding === "join")), goBack);

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
      setEditingFamily(false);
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

  if (loading) return <main className="app"><Loading>Загружаем семью…</Loading></main>;
  const isHome = Boolean(family && !inviteScreen && view === "home");
  const isFamily = Boolean(family && !inviteScreen && view === "family");
  const isFunctional = Boolean(family && !inviteScreen && (view.startsWith("tasks") || view === "purchases" || view.startsWith("shopping") || view.startsWith("wishlists")));
  const activeInvitations = invitations.filter(link => !link.revokedAt && link.expiresAt * 1000 > clock);
  const memberWord = new Intl.PluralRules("ru").select(members.length);
  return <div className={isHome ? "home-shell" : isFamily || isFunctional ? "functional-shell" : undefined}>
    {!isFamily && !isFunctional && <header className="auth-bar">
      <div className="header-identity"><div className="header-profile"><img className="user-avatar" src={user.photoUrl || "/pastel-avatar.svg"} alt="" width="56" height="56" referrerPolicy="no-referrer" /><strong>{user.firstName} {user.lastName || ""}</strong></div>
        {family && !inviteScreen ? <details className="account-menu family-menu"><summary>{family.name}</summary><button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setView(view === "family" ? "home" : "family"); setConfirmation(null); }}>{view === "family" ? "На главную" : family.role === "owner" ? "Настройки семьи" : "Участники семьи"}</button></details> : dev && <small>Тестовый профиль</small>}
      </div>
      <details className="account-menu header-account"><summary>Аккаунт</summary><button type="button" onClick={onLogout} disabled={logoutBusy}>{logoutBusy ? "Выходим…" : "Выйти из аккаунта"}</button></details>
      {authMessage && <p role="alert">{authMessage}</p>}
    </header>}
    <section className={`app family-screen${isHome ? " home-screen" : ""}${isFamily ? " family-overview" : ""}${isFamily || isFunctional ? " functional-layout" : ""}`} aria-label="Семья">
      <p className="eyebrow">Family Planner</p>
      {family && !inviteScreen && view === "family" && <button className="text-button back-button" onClick={goBack}>← На главную</button>}
      {(!family || inviteScreen || view === "family") && <div className="family-heading">
        <h1 data-screen-heading tabIndex={-1}>{inviteScreen ? "Приглашение в семью" : family ? family.name : onboarding === "join" ? "Вас пригласили в семью" : "Всё начинается с семьи"}</h1>
        {family && !inviteScreen && view === "family" && family.role === "owner" && <button
          type="button" className="text-button family-settings-toggle" aria-label="Настройки семьи" title="Настройки семьи"
          aria-expanded={editingFamily} aria-controls="family-settings" disabled={busy} onClick={() => setEditingFamily(value => !value)}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m10 3-.6 2.4-1.6.9-2.4-.7-2 3.4 1.8 1.7v2.6L3.4 15l2 3.4 2.4-.7 1.6.9L10 21h4l.6-2.4 1.6-.9 2.4.7 2-3.4-1.8-1.7v-2.6L20.6 9l-2-3.4-2.4.7-1.6-.9L14 3Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>}
      </div>}
      {isFamily && <p className="family-subtitle">Семейное пространство</p>}
      {family && !inviteScreen && view === "family" && editingFamily && family.role === "owner" && <section id="family-settings" className="settings-panel">
            <form key={`${family.id}:${family.name}:${family.timezone}`} onSubmit={save}>
              <label htmlFor="settings-name">Название</label>
              <input id="settings-name" name="name" defaultValue={family.name} maxLength={100} required disabled={busy} />
              <label htmlFor="settings-timezone">Часовой пояс</label>
              <PastelSelect label="Часовой пояс" id="settings-timezone" name="timezone" defaultValue={family.timezone} editable disabled={busy} options={["Europe/Moscow", "Europe/Kaliningrad", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Novosibirsk", "Asia/Vladivostok", "UTC"].map(zone => ({ value: zone, label: zone }))} />
              <p className="muted">Неделя начинается в понедельник.</p>
              <button className="primary" disabled={busy}>Сохранить настройки</button>
              <button type="button" disabled={busy} onClick={() => setEditingFamily(false)}>Отмена</button>
            </form>
      </section>}
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
        {view === "home" && <>
          <div className="home-intro">
            <h1 data-screen-heading tabIndex={-1}>Всё своё, вместе</h1>
            <p>Для повседневных дел и маленьких желаний.</p>
          </div>
          <nav className="home-sections" aria-label="Разделы приложения">
            <button onClick={() => setView("shopping")} aria-label="Продукты">
              <img src="/home/groceries.jpg" alt="" width="1024" height="1024" />
              <span className="home-card-caption"><strong>Продукты</strong><span aria-hidden="true">↗</span></span>
            </button>
            <button onClick={() => setView("purchases")} aria-label="Покупки">
              <img src="/home/purchases.png" alt="" width="1254" height="1254" />
              <span className="home-card-caption"><strong>Покупки</strong><span aria-hidden="true">↗</span></span>
            </button>
            <button onClick={() => setView("tasks")} aria-label="Список дел">
              <img src="/home/tasks.png" alt="" width="1254" height="1254" />
              <span className="home-card-caption"><strong>Список дел</strong><span aria-hidden="true">↗</span></span>
            </button>
            <button onClick={() => setView("wishlists")} aria-label="Вишлисты">
              <img src="/home/wishlists.png" alt="" width="1254" height="1254" />
              <span className="home-card-caption"><strong>Вишлисты</strong><span aria-hidden="true">↗</span></span>
            </button>
          </nav>
        </>}
        {view.startsWith("tasks") && <Tasks key={`${family.id}:${view}`} userId={user.id} members={members} timezone={family.timezone} fromHome={view === "tasks/new"} onBack={() => setView("home")} />}
        {view.startsWith("wishlists") && <Wishlists key={`${family.id}:${view}`} route={view} back={back} />}
        {(view.startsWith("shopping") || view === "purchases") && <Shopping key={`${family.id}:${view}`} route={view} timezone={family.timezone} back={back} />}
        {view === "family" && <>
          <div className="family-section-heading"><h2>Участники</h2><span className="family-count">{members.length} {memberWord === "one" ? "участник" : memberWord === "few" ? "участника" : "участников"}</span></div>
          <ul className="family-list member-cards">{members.map(member => <li key={member.id}>
            <img className="member-avatar" src="/svg-avatar.svg" alt="" width="64" height="64" />
            <span className="member-info"><strong>{member.firstName} {member.lastName || ""}</strong><small className="family-role">{member.role === "owner" ? "Владелец" : "Участник"}</small></span>
            {family.role === "owner" && member.role !== "owner" && <details className="family-row-menu"><summary aria-label={`Управление участником ${member.firstName}`}>⋮</summary><button className="danger" type="button" disabled={busy} onClick={() => setConfirmation({ kind: "member", id: member.id, name: member.firstName })}>Удалить участника</button></details>}
          </li>)}</ul>

          {family.role === "owner" && <>
            <section className="invite-panel">
            <div className="invite-callout">
            <div className="invite-illustration" aria-hidden="true"><i /><i /><span>+</span></div>
            <div className="invite-callout-content">
            <h2>Пригласить участника</h2>
            <p>Отправьте ссылку, чтобы присоединить членов семьи к вашему планеру.</p>
            <button className={invitation ? "" : "primary"} type="button" disabled={busy} onClick={() => void action(async () => {
              setInvitation(await apiRequest<NewInvitation>("/api/family/invitations", { method: "POST", body: "{}" }));
            })}>Создать приглашение</button>
            </div></div>
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
              <button type="button" disabled={busy} onClick={() => setInvitation(null)}>Отмена</button>
            </div>}
            <details className="active-invitations" open><summary>Активные приглашения <span className="family-count">{activeInvitations.length}</span></summary>
            {!activeInvitations.length ? <p className="empty-state">Активных приглашений пока нет.</p> : <ul className="invitation-rows">{activeInvitations.map((link, index) => <li key={link.id}>
              <span className="invitation-link-icon" aria-hidden="true">↗</span>
              <div className="invitation-info"><strong>Ссылка {index + 1}</strong><small>Действует 7 дней · Создана {new Date(link.createdAt * 1000).toLocaleDateString("ru-RU", { timeZone: family.timezone })}</small></div>
              <span className="invitation-status">Активна</span>
              {invitation?.invitation.id === link.id && <button className="text-button" type="button" aria-label={`Скопировать ссылку ${index + 1}`} onClick={async () => {
                try { await navigator.clipboard.writeText(invitation.url || invitation.token); setNotice("Приглашение скопировано."); }
                catch { setError("Не удалось скопировать ссылку. Скопируйте её из поля приглашения."); }
              }}>⧉</button>}
              <details className="family-row-menu"><summary aria-label={`Управление ссылкой ${index + 1}`}>⋮</summary><button className="danger" type="button" disabled={busy} onClick={() => setConfirmation({ kind: "invitation", id: link.id, name: "приглашение" })}>Отозвать</button></details>
            </li>)}</ul>}
            </details>
            </section>
          </>}
          {!dev && <WriteAccess />}
        </>}
      </>}
      {confirmation && <ConfirmDialog title={confirmation.kind === "member" ? `Удалить участника «${confirmation.name}»?` : "Отозвать приглашение?"}
        busy={busy} confirmLabel={confirmation.kind === "member" ? "Удалить участника" : "Отозвать приглашение"} onConfirm={() => void confirm()} onCancel={() => setConfirmation(null)}>
        <p>{confirmation.kind === "member" ? "Участник потеряет доступ к семье. По действующей ссылке он сможет вступить снова." : "По этой ссылке больше нельзя будет вступить в семью."}</p>
      </ConfirmDialog>}
    </section>
  </div>;
}
