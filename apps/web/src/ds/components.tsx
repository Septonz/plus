// Plus core components. Every screen (app, agent, helper, onboarding, /demo) is built from these
// and the tokens in tokens.css. Motion: gentle springs (motion/react); "reduce motion" is honoured
// globally by <MotionConfig reducedMotion="user"> in main.tsx.
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react'
import { useEffect, useId, type ReactNode } from 'react'
import { Icon } from './Icon'

export { Icon }
export const spring = { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 30 } as const

// ---------------------------------------------------------------------------- text

/** English (or the main language) with an optional second language in a smaller muted line beneath. */
/** The same words once tone marks and case are set aside ("Ajo" and "Àjọ"): no subtitle needed. */
export function sameWords(a: ReactNode, b: ReactNode): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return n(a) === n(b)
}

export function Bilingual({ main, sub, className = '', subClass = '' }: { main: ReactNode; sub?: ReactNode; className?: string; subClass?: string }) {
  // Global rule: a subtitle that only repeats the title (in any sheet header or label) is left out.
  if (!sub || sameWords(main, sub)) return <span className={className}>{main}</span>
  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span>{main}</span>
      <span className={`mt-0.5 text-sm font-normal tracking-normal text-secondary ${subClass}`}>{sub}</span>
    </span>
  )
}

/** Money: big, light, tabular. The currency sign is set a little smaller. */
export function AmountDisplay({ text, size = 'xl', className = '', label }: { text: string; size?: 'xl' | 'lg' | 'md' | 'sm'; className?: string; label?: ReactNode }) {
  const m = text.match(/^(-?)([^\d-]*)(.*)$/)
  const [sign, cur, rest] = m ? [m[1], m[2], m[3]] : ['', '', text]
  const sizes = { xl: 'text-6xl', lg: 'text-5xl', md: 'text-4xl', sm: 'text-2xl' }
  return (
    <div className={className}>
      {label && <p className="text-sm font-medium text-current opacity-75">{label}</p>}
      <p className={`num font-light leading-none ${sizes[size]}`} aria-label={text}>
        {sign}
        {cur && <span className="mr-0.5 align-[0.12em] text-[0.62em] font-normal">{cur.trim()}</span>}
        {rest}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------- surfaces

export function Card({ children, className = '', padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <section className={`rounded-card bg-surface shadow-card ${padded ? 'p-5' : ''} ${className}`}>{children}</section>
}

/** A titled group of content, like a settings section. */
export function Section({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`space-y-2 ${className}`}>
      {(title || action) && (
        <div className="flex min-h-11 items-center justify-between gap-3 px-1">
          {title && <h2 className="text-lg font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** Cards stacked like passes in a wallet: each overlaps the one above, the last is shown in full. */
export function CardStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col [&>*+*]:-mt-7 [&>*:last-child]:pb-5">{children}</div>
}

/** One pass in the stack. Tapping it opens CardDetail with the same layoutId (it grows into place). */
export function Pass({
  id, icon, title, sub, value, note, onOpen, tone = 'surface', children, hidden = false,
}: {
  id: string; icon: string; title: ReactNode; sub?: ReactNode; value?: ReactNode; note?: ReactNode; onOpen: () => void
  tone?: 'surface' | 'wallet'; children?: ReactNode
  /** While its detail is open, the pass keeps its place but hands its layoutId to the detail. */
  hidden?: boolean
}) {
  const wallet = tone === 'wallet'
  return (
    <motion.button
      layoutId={hidden ? undefined : `pass-${id}`}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      style={{ ...(wallet ? { background: 'var(--wallet)' } : {}), ...(hidden ? { visibility: 'hidden' } : {}) }}
      transition={spring}
      onClick={onOpen}
      whileTap={{ scale: 0.985 }}
      className={`relative block w-full overflow-hidden rounded-card p-5 pb-11 text-left shadow-lift ${wallet ? 'text-white' : 'border border-hairline/60 bg-surface text-label'}`}
    >
      {wallet && <span aria-hidden className="pointer-events-none absolute -right-16 -top-24 size-64 rounded-full bg-white/10 blur-2xl" />}
      <span className="relative flex items-start gap-3">
        <span className={`grid size-10 shrink-0 place-items-center rounded-full ${wallet ? 'bg-white/15' : 'bg-accent-soft text-accent-ink'}`}>
          <Icon name={icon} className="text-xl" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-lg font-semibold leading-tight">{title}</span>
            {value !== undefined && <span className="num shrink-0 text-lg font-medium">{value}</span>}
          </span>
          {sub && <span className={`mt-0.5 block text-sm ${wallet ? 'text-white/70' : 'text-secondary'}`}>{sub}</span>}
        </span>
        <Icon name="chevron" className={`mt-1 shrink-0 text-lg ${wallet ? 'text-white/60' : 'text-secondary'}`} />
      </span>
      {children && <span className="relative mt-4 block">{children}</span>}
      {note && <span className={`relative mt-3 block text-sm ${wallet ? 'text-white/75' : 'text-secondary'}`}>{note}</span>}
    </motion.button>
  )
}

/** A card opened full-screen. Swipe down on the header (or tap ✕) to close. */
export function CardDetail({ id, title, sub, onClose, children, fromPass = true }: { id: string; title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; fromPass?: boolean }) {
  const controls = useDragControls()
  const titleId = useId()
  useEscape(onClose)
  useLockScroll()
  function end(_: unknown, info: PanInfo) {
    if (info.offset.y > 110 || info.velocity.y > 600) onClose()
  }
  return (
    <motion.div
      layoutId={fromPass ? `pass-${id}` : undefined}
      initial={fromPass ? undefined : { y: '100%' }}
      animate={fromPass ? undefined : { y: 0 }}
      exit={fromPass ? undefined : { y: '100%' }}
      transition={spring}
      drag="y"
      dragControls={controls}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.7 }}
      onDragEnd={end}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 overflow-hidden rounded-none bg-canvas"
    >
      <div className="h-full overflow-y-auto overscroll-contain">
        <header
          onPointerDown={(e) => controls.start(e)}
          className="glass sticky top-0 z-10 touch-none border-b border-hairline/70 px-4 pb-3 pt-[max(env(safe-area-inset-top),0.5rem)]"
        >
          <span aria-hidden className="mx-auto mb-2 block h-1 w-9 rounded-full bg-fill-strong" />
          <div className="mx-auto flex max-w-md items-center gap-3">
            <h1 id={titleId} className="min-w-0 flex-1 text-2xl font-semibold">
              {sub ? <Bilingual main={title} sub={sub} /> : title}
            </h1>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
        </header>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.08 }} className="mx-auto max-w-md space-y-6 px-4 pb-28 pt-5">
          {children}
        </motion.div>
      </div>
    </motion.div>
  )
}

/** A bottom sheet over a blurred, dimmed page. Drag the grabber down to close (when allowed). */
export function Sheet({
  open, onClose, children, label, dismissible = true, className = '',
}: { open: boolean; onClose: () => void; children: ReactNode; label: string; dismissible?: boolean; className?: string }) {
  const controls = useDragControls()
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label={label}>
          <motion.div
            className="absolute inset-0 bg-scrim backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={dismissible ? onClose : undefined}
          />
          <SheetKeys onClose={dismissible ? onClose : undefined} />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={spring}
            drag={dismissible ? 'y' : false}
            dragControls={controls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => (info.offset.y > 100 || info.velocity.y > 600) && onClose()}
            className={`relative max-h-[94dvh] w-full max-w-md overflow-y-auto rounded-t-sheet bg-surface pb-[max(env(safe-area-inset-bottom),1.5rem)] shadow-lift sm:mb-4 sm:rounded-sheet ${className}`}
          >
            <div onPointerDown={(e) => dismissible && controls.start(e)} className="sticky top-0 z-10 flex touch-none justify-center bg-surface/90 pb-2 pt-2.5">
              <span aria-hidden className="block h-1 w-9 rounded-full bg-fill-strong" />
            </div>
            <div className="px-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

function SheetKeys({ onClose }: { onClose?: () => void }) {
  useEscape(onClose)
  useLockScroll()
  return null
}

function useEscape(fn?: () => void) {
  useEffect(() => {
    if (!fn) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && fn()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [fn])
}

function useLockScroll() {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])
}

// ---------------------------------------------------------------------------- lists

export function ListGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ul className={`divide-y divide-hairline overflow-hidden rounded-card bg-surface shadow-card ${className}`}>{children}</ul>
}

export function ListRow({
  icon, iconTone = 'neutral', title, subtitle, trailing, onClick, chevron, selected, className = '',
}: {
  icon?: string; iconTone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; title: ReactNode; subtitle?: ReactNode
  trailing?: ReactNode; onClick?: () => void; chevron?: boolean; selected?: boolean; className?: string
}) {
  const tones = {
    neutral: 'bg-fill text-label',
    accent: 'bg-accent-soft text-accent-ink',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  }
  const body = (
    <>
      {icon && (
        <span className={`grid size-10 shrink-0 place-items-center rounded-full ${tones[iconTone]}`}>
          <Icon name={icon} className="text-lg" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-medium leading-snug">{title}</span>
        {subtitle && <span className="line-clamp-2 block text-sm text-secondary">{subtitle}</span>}
      </span>
      {trailing && <span className="shrink-0 text-right">{trailing}</span>}
      {selected && <Icon name="check" className="shrink-0 text-xl text-accent-ink" />}
      {chevron && <Icon name="chevron" className="shrink-0 text-lg text-secondary" />}
    </>
  )
  const cls = `flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left ${className}`
  return (
    <li>
      {onClick ? (
        <button onClick={onClick} aria-pressed={selected} className={`${cls} transition-colors active:bg-fill`}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------- controls

export function Button({
  children, onClick, variant = 'primary', size = 'lg', disabled, loading, className = '', type = 'button', ariaLabel,
}: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'plain' | 'destructive' | 'success'
  size?: 'lg' | 'md' | 'sm'; disabled?: boolean; loading?: boolean; className?: string; type?: 'button' | 'submit'; ariaLabel?: string
}) {
  const v = {
    primary: 'bg-accent text-on-accent active:bg-accent-strong',
    success: 'bg-accent text-on-accent active:bg-accent-strong',
    secondary: 'bg-fill text-label active:bg-fill-strong',
    plain: 'bg-transparent text-accent-ink active:bg-fill',
    destructive: 'bg-danger-soft text-danger active:brightness-95',
  }[variant]
  const s = { lg: 'min-h-14 px-6 text-lg', md: 'min-h-12 px-5 text-lg', sm: 'min-h-11 px-4 text-base' }[size]
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      whileTap={disabled || loading ? undefined : { scale: 0.98 }}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors disabled:opacity-40 ${v} ${s} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </motion.button>
  )
}

export function IconButton({ icon, label, onClick, className = '' }: { icon: string; label: string; onClick?: () => void; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} className={`grid size-11 shrink-0 place-items-center rounded-full bg-fill text-xl text-label transition-colors active:bg-fill-strong ${className}`}>
      <Icon name={icon} />
    </button>
  )
}

export function Segmented<T extends string>({ options, value, onChange, label }: { options: [T, ReactNode][]; value: T; onChange: (v: T) => void; label: string }) {
  const id = useId()
  return (
    <div role="tablist" aria-label={label} className="relative grid rounded-full bg-fill p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
      {options.map(([v, text]) => (
        <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)} className="relative min-h-11 whitespace-nowrap rounded-full px-2 text-base font-semibold">
          {value === v && <motion.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 rounded-full bg-surface shadow-card" />}
          <span className={`relative ${value === v ? 'text-label' : 'text-secondary'}`}>{text}</span>
        </button>
      ))}
    </div>
  )
}

/** Large page title, with an optional back chevron. */
export function PageHeader({ title, sub, onBack, right }: { title: ReactNode; sub?: ReactNode; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="space-y-2 pb-1">
      {onBack && (
        <button onClick={onBack} className="-ml-2 inline-flex min-h-11 items-center gap-0.5 rounded-full px-2 text-lg font-medium text-accent-ink active:bg-fill">
          <Icon name="back" className="text-xl" /> Back
        </button>
      )}
      <div className="flex items-end gap-3">
        <h1 className="min-w-0 flex-1 text-3xl font-semibold">{sub ? <Bilingual main={title} sub={sub} /> : title}</h1>
        {right}
      </div>
    </header>
  )
}

export type NavItem<K extends string> = { key: K; label: ReactNode; icon: string; aria?: string }

/** Four items with thin icons, on frosted glass. */
/**
 * The tab bar. `center` (the mic) docks in the middle as a raised button, so it can never sit on
 * top of a keypad or a list: voice is the main way in.
 */
export function BottomNav<K extends string>({ items, active, onSelect, center }: { items: NavItem<K>[]; active: K | null; onSelect: (k: K) => void; center?: ReactNode }) {
  const half = Math.ceil(items.length / 2)
  const cells: (NavItem<K> | 'center')[] = center ? [...items.slice(0, half), 'center', ...items.slice(half)] : items
  return (
    <nav className="glass fixed inset-x-0 bottom-0 z-40 border-t border-hairline/70 pb-[env(safe-area-inset-bottom)]" aria-label="Main">
      <ul className="mx-auto grid max-w-md" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0,1fr))` }}>
        {cells.map((it) => {
          if (it === 'center') return <li key="center" className="relative flex justify-center">{center}</li>
          const on = active === it.key
          return (
            <li key={it.key}>
              <button
                onClick={() => onSelect(it.key)}
                aria-current={on ? 'page' : undefined}
                aria-label={it.aria}
                className={`flex min-h-16 w-full flex-col items-center justify-center gap-1 pt-1 text-xs font-medium transition-colors ${on ? 'text-accent-ink' : 'text-secondary'}`}
              >
                <Icon name={it.icon} className="text-2xl" strokeWidth={on ? 1.9 : 1.6} />
                <span className="leading-none">{it.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

// ---------------------------------------------------------------------------- PIN and keypad

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

/** Round keys with light numerals. 'C' clears, '⌫' deletes. */
export function NumPad({ onKey, clearLabel = 'Clear' }: { onKey: (k: string) => void; clearLabel?: string }) {
  return (
    <div className="mx-auto grid max-w-xs grid-cols-3 gap-x-6 gap-y-3">
      {KEYS.map((k) => (
        <motion.button
          key={k}
          whileTap={{ scale: 0.92 }}
          onClick={() => onKey(k)}
          aria-label={k === '⌫' ? 'Delete' : k === 'C' ? clearLabel : k}
          className={`mx-auto grid size-[4.5rem] place-items-center rounded-full ${k === 'C' || k === '⌫' ? 'text-secondary active:bg-fill' : 'bg-fill text-3xl font-light text-label active:bg-fill-strong'}`}
        >
          {k === '⌫' ? <Icon name="backspace" className="text-2xl" /> : k === 'C' ? <span className="text-base font-medium">{clearLabel}</span> : <span className="num">{k}</span>}
        </motion.button>
      ))}
    </div>
  )
}

export function PinDots({ length, max = 6 }: { length: number; max?: number }) {
  const n = Math.max(4, Math.min(max, Math.max(length, 4)))
  return (
    <div className="flex justify-center gap-4 py-3" aria-live="polite" aria-label={`${length} digits entered`}>
      {Array.from({ length: n }, (_, i) => (
        <motion.span
          key={i}
          animate={{ scale: i < length ? 1 : 0.85 }}
          transition={spring}
          className={`size-3.5 rounded-full border ${i < length ? 'border-label bg-label' : 'border-secondary/60 bg-transparent'}`}
        />
      ))}
    </div>
  )
}

/** PIN pad: dots and keys. The PIN is typed here only; never spoken, never sent through voice. */
export function PinPad({ value, onChange, max = 6, label, hint }: { value: string; onChange: (v: string) => void; max?: number; label?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="space-y-2">
      {label && <p className="flex items-center justify-center gap-2 text-center text-lg font-medium"><Icon name="lock" className="text-secondary" /> {label}</p>}
      <PinDots length={value.length} max={max} />
      <NumPad onKey={(k) => onChange(applyKey(value, k, max, true))} />
      {hint && <p className="pt-1 text-center text-sm text-secondary">{hint}</p>}
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

// ---------------------------------------------------------------------------- feedback

/** The quiet success tick: the circle settles, then the check draws itself. */
export function Tick({ size = 'lg' }: { size?: 'lg' | 'md' | 'sm' }) {
  const box = { lg: 'size-20', md: 'size-14', sm: 'size-9' }[size]
  return (
    <motion.span className={`mx-auto grid ${box} place-items-center`} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={softSpring} aria-hidden="true">
      <svg viewBox="0 0 48 48" className={box}>
        <circle cx="24" cy="24" r="23" fill="var(--success-soft)" />
        <motion.path
          d="M15 24.5l6.5 6.5L33.5 18"
          fill="none"
          stroke="var(--success)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.15, duration: 0.35, ease: 'easeOut' }}
        />
      </svg>
    </motion.span>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`spin inline-block size-[1.05em] shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton block rounded-control ${className}`} />
}

export function EmptyState({ icon = 'record', title, children, action }: { icon?: string; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card bg-surface px-6 py-10 text-center shadow-card">
      <span className="mb-1 grid size-12 place-items-center rounded-full bg-fill text-2xl text-secondary">
        <Icon name={icon} />
      </span>
      <p className="text-lg font-semibold">{title}</p>
      {children && <p className="max-w-xs text-base text-secondary">{children}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  )
}

export function Notice({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'danger' | 'info' | 'warning'; children: ReactNode }) {
  const tones = {
    neutral: ['bg-fill text-label', 'info', 'text-secondary'],
    success: ['bg-success-soft text-success-strong', 'check', ''],
    danger: ['bg-danger-soft text-danger', 'error', ''],
    info: ['bg-info-soft text-info', 'info', ''],
    warning: ['bg-warning-soft text-warning-strong', 'alert', ''],
  }[tone]
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} className={`flex gap-3 rounded-control px-4 py-3 text-base ${tones[0]}`}>
      <Icon name={tones[1]} className={`mt-0.5 text-lg ${tones[2]}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** "Verified on Stellar": a small tick that links to the transaction. The only chain word users see. */
export function VerifiedMark({ url, pending, label = 'Verified on Stellar', pendingLabel = 'Confirming…' }: { url?: string | null; pending?: boolean; label?: string; pendingLabel?: string }) {
  if (pending) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-secondary">
        <Spinner /> {pendingLabel}
      </span>
    )
  }
  const body = (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
      <Icon name="verified" className="text-sm" /> {label}
    </span>
  )
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-6 shrink-0 items-center hover:underline" aria-label={`${label}: open the record`}>
      {body}
    </a>
  ) : (
    body
  )
}

/** Sets the market accent (Nigeria green, India indigo) for the whole page. */
export function useMarketAccent(market: 'ng' | 'in' | undefined) {
  useEffect(() => {
    if (market) document.documentElement.dataset.market = market
  }, [market])
}
