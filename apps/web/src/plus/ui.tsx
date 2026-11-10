// Shared UI: bilingual labels, big buttons, icons, keypad and PIN pad.
import { createContext, useContext, useState, type ReactNode } from 'react'
import { T, type Key, type Lang } from './i18n'

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} })
export const useLang = () => useContext(LangContext)
/** Nigeria screens, the agent page and the sign-up are English first (Yoruba under it from ng/words). */
export const ENGLISH = { lang: 'en' as Lang, setLang: () => {} }

/** Tamil big, English underneath (Tamil mode); English only (English mode). */
export function L({ k, className = '', sub = 'text-ink-soft' }: { k: Key; className?: string; sub?: string }) {
  const { lang } = useLang()
  if (lang === 'en') return <span className={className}>{T[k].en}</span>
  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span>{T[k].ta}</span>
      <span className={`text-base font-normal ${sub}`}>{T[k].en}</span>
    </span>
  )
}

/** Plain string in the current language (for aria-labels and inputs). */
export function useT() {
  const { lang } = useLang()
  return (k: Key) => T[k][lang]
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-card bg-white p-5 shadow-card ${className}`}>{children}</section>
}

export function BigButton({
  children,
  onClick,
  tone = 'brick',
  disabled,
  className = '',
  type = 'button',
  loading = false,
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'brick' | 'leaf' | 'chili' | 'sand' | 'white'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
  /** Shows a spinner and blocks taps (the action is on its way). */
  loading?: boolean
}) {
  const tones = {
    brick: 'bg-brick text-cream active:bg-brick-deep',
    leaf: 'bg-leaf text-white active:brightness-90',
    chili: 'bg-chili text-white active:brightness-90',
    sand: 'bg-sand text-ink active:bg-sand-deep',
    white: 'bg-white text-ink border-2 border-line active:bg-sand',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-16 items-center justify-center gap-2 rounded-control px-5 py-3 text-xl font-bold transition active:scale-[0.99] disabled:opacity-45 ${tones[tone]} ${className}`}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function ScreenTitle({ k, onBack }: { k: Key; onBack?: () => void }) {
  const t = useT()
  return (
    <header className="flex items-center gap-3 pb-4">
      {onBack && (
        <button onClick={onBack} aria-label={t('back')} className="grid size-12 shrink-0 place-items-center rounded-full bg-sand text-2xl font-bold active:bg-sand-deep">
          <Icon name="back" />
        </button>
      )}
      <h1 className="text-3xl font-extrabold">
        <L k={k} />
      </h1>
    </header>
  )
}

export function Notice({ tone = 'sand', children }: { tone?: 'sand' | 'leaf' | 'chili' | 'sky'; children: ReactNode }) {
  const tones = { sand: 'bg-sand text-ink', leaf: 'bg-leaf-soft text-leaf-deep', chili: 'bg-chili-soft text-chili', sky: 'bg-sky-soft text-sky' }
  const icon = { sand: 'info', leaf: 'check', chili: 'alert', sky: 'info' }[tone]
  return (
    <p role={tone === 'chili' ? 'alert' : undefined} className={`flex gap-3 rounded-control px-4 py-3 text-lg font-semibold ${tones[tone]}`}>
      <Icon name={icon} className="mt-0.5 text-2xl" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  )
}

// ---------------------------------------------------------------------------
// States: loading, empty, error, success
// ---------------------------------------------------------------------------

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`spin inline-block size-[1.1em] shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

/** A grey shape where content is about to appear. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton block rounded-control ${className}`} />
}

/** Cards of placeholder rows, announced once to screen readers. */
export function LoadingList({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-card bg-white p-4 shadow-card">
          <Skeleton className="size-12 rounded-full!" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function EmptyState({ icon = 'record', title, children, action }: { icon?: string; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border-2 border-dashed border-line px-5 py-8 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-sand text-3xl text-brick">
        <Icon name={icon} />
      </span>
      <p className="text-xl font-extrabold">{title}</p>
      {children && <p className="text-lg text-ink-soft">{children}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card bg-chili-soft px-5 py-6 text-center text-chili" role="alert">
      <Icon name="alert" className="text-4xl" />
      <p className="text-lg font-semibold">{text}</p>
      {onRetry && (
        <button onClick={onRetry} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-5 text-lg font-bold text-chili">
          <Icon name="refresh" /> Try again
        </button>
      )}
    </div>
  )
}

/** The success tick: the circle pops in and the check draws itself. */
export function SuccessTick({ size = 'lg' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-24' : 'size-16'
  return (
    <span className={`relative mx-auto grid ${box} place-items-center`} aria-hidden="true">
      <span className="tick-ring absolute inset-0 rounded-full bg-leaf/40" />
      <svg viewBox="0 0 48 48" className={`tick-pop relative ${box}`}>
        <circle cx="24" cy="24" r="23" fill="var(--color-leaf)" />
        <path className="tick-draw" d="M14 24.5l7 7L34.5 18" fill="none" stroke="white" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  inputMode,
  autoComplete = 'off',
  autoFocus,
  maxLength,
}: {
  label: ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: ReactNode
  inputMode?: 'text' | 'tel' | 'numeric'
  autoComplete?: string
  autoFocus?: boolean
  maxLength?: number
}) {
  return (
    <label className="block">
      <span className="text-xl font-bold">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        maxLength={maxLength}
        className="mt-2 block min-h-16 w-full rounded-control border-2 border-line bg-white px-4 text-2xl font-bold text-ink focus:border-brick"
      />
      {hint && <span className="mt-1 block text-base text-ink-soft">{hint}</span>}
    </label>
  )
}

/** Copies text and says so for two seconds. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button
      onClick={() => void copy()}
      aria-live="polite"
      className={`inline-flex min-h-12 items-center gap-2 rounded-full px-5 text-lg font-bold ${copied ? 'bg-leaf text-white' : 'bg-brick text-cream active:bg-brick-deep'}`}
    >
      <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : label}
    </button>
  )
}

/** A text message drawn on screen (the demo shows SMS here instead of sending it). */
export function SmsBubble({ to, text, note = 'Text message (simulated on this demo)' }: { to: string; text: string; note?: string }) {
  return (
    <figure className="sheet-in rounded-card border-2 border-sky/20 bg-sky-soft p-4">
      <figcaption className="flex items-center gap-2 text-base font-bold text-sky">
        <Icon name="sms" className="text-xl" /> {note}
      </figcaption>
      <p className="mt-1 text-base text-ink-soft">To {to}</p>
      <blockquote className="mt-2 rounded-2xl rounded-tl-sm bg-white px-4 py-3 text-lg font-semibold text-ink shadow-card">{text}</blockquote>
    </figure>
  )
}

// ---------------------------------------------------------------------------
// Icons (inline, stroke-based, sized by font-size)
// ---------------------------------------------------------------------------

const PATHS: Record<string, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3',
  stop: 'M7 7h10v10H7z',
  home: 'M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  pay: 'M4 12h14m-5-6 6 6-6 6',
  group: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 20c0-3 3-5 6-5s6 2 6 5m0-5c3 0 8 1 8 5',
  advance: 'M12 3v18m5-14H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6',
  record: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3',
  add: 'M12 5v14M5 12h14',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  back: 'M15 5l-7 7 7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  flower: 'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-6a3 3 0 0 1 3-3 3 3 0 0 1-3 3Zm0 0a3 3 0 0 0-3-3 3 3 0 0 0 3 3Zm0 6v8m0-3c-2 0-4-1-5-3m5 3c2 0 4-1 5-3',
  medical: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9c0-4 4-6 8-6s8 2 8 6',
  bank: 'M3 9l9-5 9 5M5 9v9m4-9v9m6-9v9m4-9v9M3 21h18',
  hand: 'M7 11V6a1.5 1.5 0 0 1 3 0v4m0-5a1.5 1.5 0 0 1 3 0v5m0-4a1.5 1.5 0 0 1 3 0v6m-9-1-1.5-1.5a1.6 1.6 0 0 0-2.3 2.3L9 19c1.3 1.3 2.7 2 4.5 2H15a5 5 0 0 0 5-5v-5a1.5 1.5 0 0 0-3 0',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z',
  wages: 'M4 7h16v10H4zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 10v.01M17 14v.01',
  gov: 'M12 3l9 4H3zM5 10h14M6 10v7m4-7v7m4-7v7m4-7v7M3 20h18',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  backspace: 'M21 5H9l-6 7 6 7h12zM12 9l6 6m0-6-6 6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  phone: 'M7 2h10v20H7zM11 18h2',
  camera: 'M4 8h3l2-3h6l2 3h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  id: 'M3 5h18v14H3zM8 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 4c.5-1.6 1.6-2.5 3-2.5s2.5.9 3 2.5M14 9h4m-4 3h4m-4 3h3',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  sms: 'M4 5h16v11H9l-5 4zM8 9h8m-8 3h5',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l3-3h11v3M16 13.5h.01',
  refresh: 'M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4',
  userPlus: 'M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9c0-4 3-6 7-6 1.4 0 2.6.2 3.6.7M18 14v6m-3-3h6',
  alert: 'M12 3l10 18H2zM12 10v4m0 3v.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-11v6m0-9v.01',
  star4: 'M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z',
}

export function Icon({ name, className = '' }: { name: keyof typeof PATHS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`inline-block size-[1.2em] shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name] ?? PATHS.star} />
    </svg>
  )
}

/** Small "verified on Stellar" mark, linking to the transaction. */
export function StellarMark({ url, pending = false }: { url?: string | null; pending?: boolean }) {
  const t = useT()
  if (pending) {
    return <span className="inline-flex items-center gap-2 rounded-full bg-sand px-3 py-1 text-base font-semibold text-ink-soft"><Spinner /> {t('waitingForStellar')}</span>
  }
  const body = (
    <span className="inline-flex items-center gap-1 rounded-full bg-leaf-soft px-3 py-1 text-base font-semibold text-leaf">
      <Icon name="check" /> {t('verifiedOnStellar')}
    </span>
  )
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex">
      {body}
    </a>
  ) : (
    body
  )
}

// ---------------------------------------------------------------------------
// Keypad (amounts) and PIN pad
// ---------------------------------------------------------------------------

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

export function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const t = useT()
  return (
    <div className="grid grid-cols-3 gap-3">
      {KEYS.map((k) => (
        <button
          key={k}
          onClick={() => onKey(k)}
          aria-label={k === '⌫' ? 'backspace' : k === 'C' ? t('clear') : k}
          className="grid h-16 place-items-center rounded-control bg-white text-3xl font-bold text-ink shadow-card active:bg-sand"
        >
          {k === '⌫' ? <Icon name="backspace" /> : k === 'C' ? <span className="text-xl">{t('clear')}</span> : k}
        </button>
      ))}
    </div>
  )
}

export function applyKey(value: string, k: string, maxLen: number, leadingZero = false): string {
  if (k === 'C') return ''
  if (k === '⌫') return value.slice(0, -1)
  if (value.length >= maxLen) return value
  if (value === '' && k === '0' && !leadingZero) return value
  return value + k
}

export function PinDots({ length, max = 6 }: { length: number; max?: number }) {
  return (
    <div className="flex justify-center gap-3 py-3" aria-live="polite" aria-label={`${length} digits`}>
      {Array.from({ length: Math.max(4, Math.min(max, Math.max(length, 4))) }, (_, i) => (
        <span key={i} className={`size-5 rounded-full border-2 border-brick ${i < length ? 'bg-brick' : 'bg-transparent'}`} />
      ))}
    </div>
  )
}
