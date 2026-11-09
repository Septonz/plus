// Shared UI: bilingual labels, big buttons, icons, keypad and PIN pad.
import { createContext, useContext, type ReactNode } from 'react'
import { T, type Key, type Lang } from './i18n'

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'ta', setLang: () => {} })
export const useLang = () => useContext(LangContext)

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
  return <section className={`rounded-3xl bg-white p-5 shadow-[0_2px_0_0_var(--color-sand-deep)] ${className}`}>{children}</section>
}

export function BigButton({
  children,
  onClick,
  tone = 'brick',
  disabled,
  className = '',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'brick' | 'leaf' | 'chili' | 'sand' | 'white'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  const tones = {
    brick: 'bg-brick text-cream active:bg-brick-deep',
    leaf: 'bg-leaf text-white active:brightness-90',
    chili: 'bg-chili text-white active:brightness-90',
    sand: 'bg-sand text-ink active:bg-sand-deep',
    white: 'bg-white text-ink border-2 border-sand-deep active:bg-sand',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-16 rounded-2xl px-5 py-3 text-xl font-bold transition disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  )
}

export function ScreenTitle({ k, onBack }: { k: Key; onBack?: () => void }) {
  const t = useT()
  return (
    <header className="flex items-center gap-3 pb-4">
      {onBack && (
        <button onClick={onBack} aria-label={t('back')} className="grid size-12 place-items-center rounded-full bg-sand text-2xl font-bold">
          <Icon name="back" />
        </button>
      )}
      <h1 className="text-3xl font-extrabold">
        <L k={k} />
      </h1>
    </header>
  )
}

export function Notice({ tone = 'sand', children }: { tone?: 'sand' | 'leaf' | 'chili'; children: ReactNode }) {
  const tones = { sand: 'bg-sand text-ink', leaf: 'bg-leaf-soft text-leaf', chili: 'bg-chili-soft text-chili' }
  return <p className={`rounded-2xl px-4 py-3 text-lg font-semibold ${tones[tone]}`}>{children}</p>
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
    return <span className="inline-flex items-center gap-1 rounded-full bg-sand px-3 py-1 text-base font-semibold text-ink-soft">⏳ {t('waitingForStellar')}</span>
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
          className="h-16 rounded-2xl bg-white text-3xl font-bold text-ink shadow-[0_2px_0_0_var(--color-sand-deep)] active:bg-sand"
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
