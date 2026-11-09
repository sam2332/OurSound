// Small touch-friendly building blocks shared by the screens.

import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-card p-4 flex flex-col gap-3', className)}>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'soft',
  className,
  disabled,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'soft' | 'primary' | 'danger' | 'ghost';
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-medium transition active:scale-[0.98] disabled:opacity-40 [&>svg]:shrink-0',
        variant === 'soft' && 'bg-accent-soft text-ink',
        variant === 'primary' && 'bg-accent text-bg font-bold',
        variant === 'danger' && 'bg-danger/15 text-danger',
        variant === 'ghost' && 'bg-transparent text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  label,
  active,
  className,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  label: string;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-30',
        active ? 'bg-accent text-bg' : 'bg-accent-soft text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Slider with a label, live value, and an editable number for exact entry. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled,
  color,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
  color?: string;
  format?: (v: number) => string;
  hint?: ReactNode;
}) {
  const s = step ?? niceStep(min, max);
  const fill = ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="flex items-baseline gap-1">
          {hint}
          {format ? (
            <b className="tabular-nums">{format(value)}</b>
          ) : (
            <NumberField value={value} min={min} max={max} step={s} onChange={onChange} disabled={disabled} />
          )}
          {unit && !format && <span className="text-muted">{unit}</span>}
        </span>
      </span>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={s}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${fill}%`, ['--track-fill' as string]: color }}
      />
    </label>
  );
}

function niceStep(min: number, max: number): number {
  const raw = (max - min) / 400;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw;
}

function decimalsFor(step: number) {
  return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
}

/** Compact number input that commits on blur / enter, clamped to [min, max]. */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  className,
  width = 'w-16',
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  className?: string;
  width?: string;
}) {
  const d = decimalsFor(step);
  const [text, setText] = useState(value.toFixed(d));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(value.toFixed(d));
  }, [value, d, editing]);
  const commit = () => {
    setEditing(false);
    const v = Number(text);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
    else setText(value.toFixed(d));
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      disabled={disabled}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cx(
        width,
        'rounded-md bg-transparent px-0.5 text-right font-bold tabular-nums outline-none focus:bg-card focus:ring-1 focus:ring-accent',
        className,
      )}
    />
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cx('grid gap-1 rounded-xl bg-card-2 p-1', className)}
      style={{ gridTemplateColumns: `repeat(${options.length > 4 ? 3 : options.length}, 1fr)` }}
    >
      {options.map((o) => (
        <button
          type="button"
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-lg px-2 py-2 text-sm transition',
            o.value === value ? 'bg-accent text-bg font-semibold' : 'text-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Hours / minutes / seconds entry for long durations (supports thousands of hours). */
export function TimeInput({
  label,
  value,
  onChange,
  min = 0,
  showSeconds = true,
}: {
  label: string;
  value: number;
  onChange: (sec: number) => void;
  min?: number;
  showSeconds?: boolean;
}) {
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.round(value % 60);
  const set = (nh: number, nm: number, ns: number) => onChange(Math.max(min, nh * 3600 + nm * 60 + ns));
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 flex-1 text-muted">{label}</span>
      <span className="flex shrink-0 items-center gap-0.5 rounded-lg bg-bg/40 px-2 py-1.5">
        <NumberField value={h} min={0} max={99999} onChange={(v) => set(v, m, s)} width="w-12" />
        <span className="mr-1 text-muted">h</span>
        <NumberField value={m} min={0} max={59} onChange={(v) => set(h, v, s)} width="w-7" />
        <span className={showSeconds ? 'mr-1 text-muted' : 'text-muted'}>m</span>
        {showSeconds && (
          <>
            <NumberField value={s} min={0} max={59} onChange={(v) => set(h, m, v)} width="w-7" />
            <span className="text-muted">s</span>
          </>
        )}
      </span>
    </div>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="pb-safe max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-line bg-card px-4 pt-3"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-3 pb-2">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <p className="text-muted">{message}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}
