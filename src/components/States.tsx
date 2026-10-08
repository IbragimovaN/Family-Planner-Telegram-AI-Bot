import { useEffect, useId, useRef, type ReactNode } from "react";

export function Loading({ children = "Загружаем…" }: { children?: ReactNode }) {
  return <p role="status" aria-live="polite">{children}</p>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-notice"><p role="alert">{message}</p>{retry && <button type="button" onClick={retry}>Попробовать снова</button>}</div>;
}
export function ConfirmDialog({ title, children, busy, confirmLabel, onConfirm, onCancel }: {
  title: string; children: ReactNode; busy: boolean; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="confirm-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id={titleId}>{title}</h2><div id={descriptionId}>{children}</div>
    <div className="button-row"><button type="button" autoFocus disabled={busy} onClick={onCancel}>Отмена</button>
      <button type="button" className="danger" disabled={busy} onClick={onConfirm}>{busy ? "Сохраняем…" : confirmLabel}</button></div>
  </dialog>;
}
