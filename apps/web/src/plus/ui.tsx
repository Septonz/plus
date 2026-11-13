// Shared UI, kept as the app's stable API (L, BigButton, Card, Notice…) and drawn with the design
// system in ../ds. New screens can use ../ds directly.
import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  applyKey, Button, Card as DsCard, EmptyState as DsEmpty, Icon, IconButton, NumPad, Notice as DsNotice, PinDots, Skeleton, Spinner, Tick,
  VerifiedMark,
} from '../ds/components'
import { T, type Key, type Lang } from './i18n'

export { applyKey, Icon, PinDots, Skeleton, Spinner }

export const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} })
export const useLang = () => useContext(LangContext)
/** Nigeria screens, the agent page and the sign-up are English first (Yoruba under it from ng/words). */
export const ENGLISH = { lang: 'en' as Lang, setLang: () => {} }

/** English first; in Tamil mode, Tamil in a smaller muted line beneath. */
export function L({ k, className = '', sub = 'text-secondary' }: { k: Key; className?: string; sub?: string }) {
  const { lang } = useLang()
  if (lang === 'en') return <span className={className}>{T[k].en}</span>
  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span>{T[k].en}</span>
      <span className={`mt-0.5 text-sm font-normal tracking-normal ${sub}`}>{T[k].ta}</span>
    </span>
  )
}

/** Plain string in the current language (for aria-labels and inputs). */
export function useT() {
  const { lang } = useLang()
  return (k: Key) => T[k][lang]
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <DsCard className={className}>{children}</DsCard>
}

const TONE = { brick: 'primary', leaf: 'success', chili: 'destructive', sand: 'secondary', white: 'secondary' } as const

export function BigButton({
  children, onClick, tone = 'brick', disabled, className = '', type = 'button', loading = false,
}: {
  children: ReactNode
  onClick?: () => void
  tone?: keyof typeof TONE
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
  loading?: boolean
}) {
  return (
    <Button variant={TONE[tone]} onClick={onClick} disabled={disabled} loading={loading} type={type} className={className}>
      {children}
    </Button>
  )
}

export function ScreenTitle({ k, onBack }: { k: Key; onBack?: () => void }) {
  const t = useT()
  return (
    <header className="flex items-center gap-3 pb-2">
      {onBack && <IconButton icon="back" label={t('back')} onClick={onBack} />}
      <h1 className="text-3xl font-semibold">
        <L k={k} />
      </h1>
    </header>
  )
}

export function Notice({ tone = 'sand', children }: { tone?: 'sand' | 'leaf' | 'chili' | 'sky'; children: ReactNode }) {
  const map = { sand: 'neutral', leaf: 'success', chili: 'danger', sky: 'info' } as const
  return <DsNotice tone={map[tone]}>{children}</DsNotice>
}

/** Rows of placeholders, announced once to screen readers. */
export function LoadingList({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="divide-y divide-hairline overflow-hidden rounded-card bg-surface shadow-card" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-10 rounded-full!" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function EmptyState(p: { icon?: string; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <DsEmpty {...p} />
}

export function ErrorState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card bg-surface px-6 py-8 text-center shadow-card" role="alert">
      <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-2xl text-danger"><Icon name="error" /></span>
      <p className="text-lg">{text}</p>
      {onRetry && (
        <Button variant="secondary" size="md" onClick={onRetry}>
          <Icon name="refresh" /> Try again
        </Button>
      )}
    </div>
  )
}

export function SuccessTick({ size = 'lg' }: { size?: 'md' | 'lg' }) {
  return <Tick size={size} />
}

export function TextField({
  label, value, onChange, placeholder, hint, inputMode, autoComplete = 'off', autoFocus, maxLength, type = 'text',
}: {
  type?: 'text' | 'password'
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
      <span className="text-base font-medium text-secondary">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        maxLength={maxLength}
        type={type}
        className="mt-1.5 block min-h-14 w-full rounded-control border border-hairline bg-surface-2 px-4 text-xl text-label transition-colors focus:border-accent focus:bg-surface focus:outline-none"
      />
      {hint && <span className="mt-1.5 block text-sm text-secondary">{hint}</span>}
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
    <span aria-live="polite">
      <Button variant="secondary" size="md" onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} className={copied ? 'text-success' : ''} /> {copied ? 'Copied' : label}
      </Button>
    </span>
  )
}

/** A text message drawn on screen (the demo shows SMS here instead of sending it). */
export function SmsBubble({ to, text, note = 'Text message · simulated on this demo' }: { to: string; text: string; note?: string }) {
  return (
    <figure className="sheet-in rounded-card bg-surface-2 p-4">
      <figcaption className="flex items-center gap-2 text-sm font-medium text-secondary">
        <Icon name="sms" /> {note}
      </figcaption>
      <p className="mt-1 text-sm text-secondary">To {to}</p>
      <blockquote className="mt-2 rounded-[1.25rem] rounded-tl-md bg-info-soft px-4 py-3 text-base text-label">{text}</blockquote>
    </figure>
  )
}

/** "Verified on Stellar", linking to the transaction. */
export function StellarMark({ url, pending = false }: { url?: string | null; pending?: boolean }) {
  const t = useT()
  return <VerifiedMark url={url} pending={pending} label={t('verifiedOnStellar')} pendingLabel={t('waitingForStellar')} />
}

export function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const t = useT()
  return <NumPad onKey={onKey} clearLabel={t('clear')} />
}
