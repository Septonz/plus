// The confirm sheet, shared by every market: the amount large and centred, who it's to, the full
// cost, then Yes / No (and the PIN pad above the market's threshold) over a blurred page. After Yes:
// "Sending" while the ledger closes, then a quiet tick and "Done".
import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { AmountDisplay, Bilingual, Button, Icon, Notice, PinPad, Sheet, Spinner, Tick } from './components'

export type ConfirmPhase = 'ask' | 'working' | 'sending' | 'done' | 'failed'
export type CostLine = { label: ReactNode; value?: ReactNode; strong?: boolean }

export function ConfirmSheet({
  phase, heading, amount, big, to, toSub, lines = [], info, pin, onPin, pinLabel, pinHint, pinNeeded = false,
  yes, no, working = 'One moment…', closeLabel, onYes, onNo, onClose, message, sending, done, label = 'Confirm',
}: {
  phase: ConfirmPhase
  heading: ReactNode
  amount?: string | null
  /** Instead of an amount (e.g. "10%" for an auto-save change). */
  big?: ReactNode
  to?: ReactNode
  toSub?: ReactNode
  lines?: CostLine[]
  info?: ReactNode
  pinNeeded?: boolean
  pin?: string
  onPin?: (v: string) => void
  pinLabel?: ReactNode
  pinHint?: ReactNode
  yes: ReactNode
  no: ReactNode
  working?: ReactNode
  closeLabel: ReactNode
  onYes: () => void
  onNo: () => void
  onClose: () => void
  message?: string | null
  /** Shown while sending (a cash-out code, a text message). */
  sending?: ReactNode
  /** Shown under the tick (balance, link, Save this person). */
  done?: ReactNode
  label?: string
}) {
  const asking = phase === 'ask' || phase === 'working'
  return (
    <Sheet open onClose={onClose} label={label} dismissible={phase !== 'working'}>
      <div className="pb-2 pt-1 text-center">
        <p className="text-sm font-medium uppercase tracking-wide text-secondary">{heading}</p>
        <div className="mt-4">
          {amount ? <AmountDisplay text={amount} size="xl" /> : big}
        </div>
        {to && (
          <p className="mt-3 text-xl font-medium">
            <Bilingual main={to} sub={toSub} />
          </p>
        )}
      </div>

      {lines.length > 0 && (
        <dl className="mt-4 divide-y divide-hairline rounded-card bg-surface-2">
          {lines.map((l, i) => (
            <div key={i} className="flex items-start justify-between gap-4 px-4 py-3 text-base">
              <dt className={l.strong ? 'font-medium' : 'text-secondary'}>{l.label}</dt>
              {l.value !== undefined && <dd className={`num text-right ${l.strong ? 'font-semibold' : 'font-medium'}`}>{l.value}</dd>}
            </div>
          ))}
        </dl>
      )}
      {info && asking && <div className="mt-3 text-center text-base text-secondary">{info}</div>}

      <AnimatePresence mode="wait" initial={false}>
        {asking && (
          <motion.div key="ask" exit={{ opacity: 0 }} className="mt-5 space-y-4">
            {message && <Notice tone="danger">{message}</Notice>}
            {pinNeeded && onPin && <PinPad value={pin ?? ''} onChange={onPin} label={pinLabel} hint={pinHint} />}
            <div className="grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={onNo} disabled={phase === 'working'}>
                <Icon name="x" /> {no}
              </Button>
              <Button variant="primary" onClick={onYes} disabled={phase === 'working' || (pinNeeded && (pin ?? '').length < 4)}>
                {phase === 'working' ? <><Spinner /> {working}</> : <><Icon name="check" /> {yes}</>}
              </Button>
            </div>
          </motion.div>
        )}
        {phase === 'sending' && (
          <motion.div key="sending" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-6 space-y-4 text-center" role="status">
            <p className="flex items-center justify-center gap-2 text-lg text-secondary"><Spinner /> Sending…</p>
            {sending}
          </motion.div>
        )}
        {phase === 'done' && (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6 space-y-4 text-center">
            <Tick />
            <p className="text-2xl font-semibold">Done</p>
            {done}
            <Button variant="secondary" className="w-full" onClick={onClose}>{closeLabel}</Button>
          </motion.div>
        )}
        {phase === 'failed' && (
          <motion.div key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-6 space-y-4">
            {message && <Notice tone="neutral">{message}</Notice>}
            <Button variant="secondary" className="w-full" onClick={onClose}>{closeLabel}</Button>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  )
}
