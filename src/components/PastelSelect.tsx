import { useId, useRef, useState } from "react";

type Props = {
  label: string;
  options: { value: string; label: string }[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  editable?: boolean;
  id?: string;
  name?: string;
};

export default function PastelSelect({ label, options, value, defaultValue = "", onChange, disabled, editable, id, name }: Props) {
  const [localValue, setLocalValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const selected = value ?? localValue;
  function change(next: string) { setLocalValue(next); onChange?.(next); }
  return <div className="pastel-select" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <div className="pastel-select-field">
      {editable && <input id={id} name={name} aria-label={label} required disabled={disabled} value={selected} onChange={e => change(e.target.value)} />}
      <button ref={trigger} id={editable ? undefined : id} type="button" disabled={disabled} aria-label={editable ? `Выбрать: ${label}` : `${label}: ${options.find(option => option.value === selected)?.label || selected}`} aria-expanded={open} aria-controls={popupId} onClick={() => setOpen(!open)}>
        {!editable && <span>{options.find(option => option.value === selected)?.label || selected}</span>}<span aria-hidden="true">▾</span>
      </button>
    </div>
    {open && <div id={popupId} className="pastel-select-options" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} disabled={disabled} aria-pressed={selected === option.value} onClick={() => { change(option.value); setOpen(false); trigger.current?.focus(); }}>{option.label}</button>)}</div>}
  </div>;
}
