import { useEffect, useId, useRef, type ReactNode } from "react";

export default function FormDialog({ title, busy, close, children }: { title: string; busy: boolean; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement, node = dialog.current;
    node?.showModal();
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog wishlist-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <div className="wishlist-dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label="Закрыть" disabled={busy} onClick={close}>×</button></div>
    {children}
  </dialog>;
}
