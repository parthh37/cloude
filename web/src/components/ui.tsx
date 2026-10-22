import clsx from 'clsx';
import { X } from 'lucide-react';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { SessionStatus } from '../../../shared/protocol';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'attention';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode; busy?: boolean }>(
  // type defaults to "button": a bare <button> inside a form is a submit button, so Enter would trigger the first one (e.g. "Back").
  function Button({ variant = 'secondary', size = 'md', icon, busy, className, children, disabled, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || busy}
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed select-none',
          size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-10 px-3.5 text-sm',
          variant === 'primary' && 'bg-sky text-on-sky hover:bg-sky/85',
          variant === 'secondary' && 'bg-surface border border-line text-ink hover:border-line-strong hover:bg-surface-2',
          variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
          variant === 'danger' && 'bg-bad text-white hover:bg-bad/90',
          variant === 'attention' && 'bg-break text-[#2b1d05] hover:bg-break/90',
          className,
        )}
        {...rest}
      >
        {busy ? <Spinner className="size-4" /> : icon}
        {children}
      </button>
    );
  },
);

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={clsx('inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-40', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={clsx(
        'h-10 w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-ink placeholder:text-ink-3 focus:border-sky focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={clsx(
        'w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-sky focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx('h-10 rounded-md border border-line bg-surface-2 px-2.5 text-sm text-ink focus:border-sky focus:outline-none', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx('relative h-6 w-10 shrink-0 rounded-full transition-colors', checked ? 'bg-sky' : 'bg-line-strong')}
    >
      <span className={clsx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx('animate-spin', className ?? 'size-4')} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function StatusDot({ status, className }: { status: SessionStatus | 'stopped' | 'crashed' | 'building'; className?: string }) {
  // Magenta = Claude is flying; amber = needs you; red = failed.
  const color =
    status === 'running' || status === 'starting'
      ? 'bg-dawn'
      : status === 'building'
        ? 'bg-sky'
        : status === 'awaiting_input'
        ? 'bg-break'
        : status === 'error' || status === 'crashed'
          ? 'bg-bad'
          : 'bg-line-strong';
  const pulse = status === 'running' || status === 'starting' || status === 'awaiting_input' || status === 'building';
  return (
    <span className={clsx('relative inline-flex size-2.5 shrink-0', className)}>
      {pulse && <span className={clsx('absolute inset-0 animate-ping rounded-full opacity-50', color)} />}
      <span className={clsx('relative inline-flex size-2.5 rounded-full', color)} />
    </span>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'sky' | 'break' | 'ok' | 'bad' | 'dawn'; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-[3px] px-1.5 py-[3px] font-hud text-[10.5px] leading-none tracking-[0.04em] whitespace-nowrap',
        tone === 'neutral' && 'bg-surface-2 text-ink-2 border border-line',
        tone === 'sky' && 'bg-sky-soft text-sky',
        tone === 'break' && 'bg-break-soft text-break-ink',
        tone === 'ok' && 'bg-ok-soft text-ok',
        tone === 'bad' && 'bg-bad-soft text-bad',
        tone === 'dawn' && 'bg-dawn-soft text-dawn-ink',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={clsx(
          'pb-safe max-h-[92vh] w-full overflow-y-auto rounded-t-xl border border-line-strong bg-surface shadow-cloud sm:rounded-xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-5 py-3.5">
          <h2 className="font-display text-base font-bold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-ink-3">{icon}</div>}
      <p className="font-display text-base font-bold">{title}</p>
      {children && <div className="mt-1.5 max-w-sm text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={clsx('size-6', className)} aria-hidden>
      <rect x="1.5" y="1.5" width="61" height="61" rx="12.5" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.5" />
      <path d="M20 42h25a9 9 0 0 0 1-17.9A12 12 0 0 0 23.3 27 8 8 0 0 0 20 42z" fill="var(--ink)" />
      <path d="M16 49h32" stroke="var(--dawn)" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 font-display font-bold tracking-[0.02em]', className)}>
      <Mark />
      Cloude
    </span>
  );
}
