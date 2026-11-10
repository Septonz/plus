// Nigeria confirm sheet: the read-back, big Yes / No, the PIN pad above the market's PIN threshold
// (typed here, never spoken). After Yes, confirm_action answers "sending" at once; the sheet then
// waits for the transaction row to turn completed (chain-worker saw it in a closed ledger) and
// shows the tick, the seconds it took and the Stellar Expert link. A cash-out shows its code once.
import { useEffect, useRef, useState } from 'react'
import { getMarket } from '@plus/markets'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, Tx } from '../plus/data'
import { applyKey, BigButton, Icon, Keypad, Notice, PinDots } from '../plus/ui'
import { naira, W, Y } from './words'

const EXPLORER = 'https://stellar.expert/explorer/testnet'

export function ngNeedsPin(a: PendingAction): boolean {
  if (!['pay', 'group_contribution', 'cash_out'].includes(a.kind)) return false
  return BigInt(String(a.params.amount ?? 0)) > BigInt(getMarket('ng').pinThreshold) * 100n
}

function title(a: PendingAction): string {
  const p = a.params
  switch (a.kind) {
    case 'pay':
      return `to ${String(p.payee_name ?? '')}`
    case 'group_contribution':
      return `for ${String(p.group_name ?? 'your ajo')}`
    case 'advance':
      return `advance · fee ${naira(String(p.fee ?? 0))}`
    case 'cash_out':
      return 'cash out with an agent'
    case 'confirm_cash_in':
      return `cash you gave ${String(p.helper_name ?? 'the agent')}`
    default:
      return ''
  }
}

type Phase = 'ask' | 'working' | 'sending' | 'done' | 'failed'

export function NgConfirmSheet({ action, txs, onClose }: { action: PendingAction; txs: Tx[]; onClose: () => void }) {
  const pinNeeded = ngNeedsPin(action)
  const [pin, setPin] = useState('')
  const [phase, setPhase] = useState<Phase>('ask')
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ToolResult | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const t0 = useRef(0)

  const txId = typeof result?.transaction_id === 'string' ? result.transaction_id : null
  const tx = txId ? txs.find((t) => t.id === txId) : undefined
  // The tick: the transaction row turned completed (Realtime brought it here).
  useEffect(() => {
    if (phase !== 'sending' || !tx) return
    if (tx.status === 'completed') {
      setSeconds((Date.now() - t0.current) / 1000)
      setPhase('done')
    } else if (tx.status === 'failed') {
      setMessage("It didn't go through. Nothing left your wallet.")
      setPhase('failed')
    }
  }, [phase, tx])

  async function yes() {
    setPhase('working')
    setMessage(null)
    t0.current = Date.now()
    const r = await tool('confirm_action', pinNeeded ? { action_id: action.id, pin } : { action_id: action.id }).catch(
      () => ({ text: 'No connection. Tap again.', ok: false, error: 'network' }) as ToolResult,
    )
    setPin('')
    if (r.status === 'done') {
      setResult(r)
      setPhase('sending')
      return
    }
    setPhase(r.status === 'failed' || r.status === 'expired' || r.status === 'rejected' ? 'failed' : 'ask')
    setMessage(r.text || "It didn't go through. Try again.")
  }

  async function no() {
    setPhase('working')
    await tool('reject_action', { action_id: action.id }).catch(() => null)
    setMessage(action.kind === 'confirm_cash_in' ? 'Okay. That cash is marked as not received.' : 'Okay, cancelled. Nothing was sent.')
    setPhase('failed')
  }

  const code = typeof result?.cash_out_code === 'string' ? result.cash_out_code : null
  const amount = action.params.amount !== undefined ? naira(String(action.params.amount)) : null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="ng-confirm-title">
      <div className="sheet-in max-h-[100dvh] w-full max-w-md overflow-y-auto rounded-t-[2rem] bg-cream px-5 pb-8 pt-6 sm:rounded-[2rem]">
        <h2 id="ng-confirm-title" className="mb-4 text-center text-2xl font-extrabold">
          {phase === 'done' ? <Y k="done" /> : phase === 'sending' ? <Y k="sending" /> : action.kind === 'confirm_cash_in' ? <Y k="isThatRight" /> : <Y k="checkThis" />}
        </h2>

        <div className="text-center">
          {amount && <p className="text-6xl font-extrabold tracking-tight text-brick">{amount}</p>}
          <p className="mt-3 text-2xl font-bold">{title(action)}</p>
          {action.kind === 'advance' && (
            <ul className="mx-auto mt-3 max-w-xs space-y-1 text-left text-lg">
              <li>✓ One fee: {naira(String(action.params.fee ?? 0))}</li>
              <li>✓ No interest</li>
              <li>✓ No late fees</li>
              <li>✓ Pays back by itself: {getMarket('ng').advance.repayFromCashInBps / 100}% of each cash-in</li>
            </ul>
          )}
          {action.kind === 'cash_out' && phase === 'ask' && (
            <p className="mt-2 text-lg text-ink-soft">You get a code. Show it to the agent and collect your cash.</p>
          )}
        </div>

        {phase === 'sending' && (
          <div className="mt-6 space-y-4 text-center">
            <p className="mx-auto grid size-20 animate-pulse place-items-center rounded-full bg-sand text-4xl">⏳</p>
            {code && <CodeBox code={code} />}
            <p className="text-lg text-ink-soft">{result?.text}</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="mt-6 space-y-4 text-center">
            <p className="mx-auto grid size-20 place-items-center rounded-full bg-leaf text-5xl text-white">
              <Icon name="check" />
            </p>
            {code && <CodeBox code={code} />}
            <p className="text-lg font-semibold text-leaf">
              {W.verified.en}
              {seconds !== null && ` in ${seconds.toFixed(1)} s`}
            </p>
            {tx?.chain_tx_hash && (
              <a className="inline-flex items-center gap-1 text-lg font-bold text-brick underline" href={`${EXPLORER}/tx/${tx.chain_tx_hash}`} target="_blank" rel="noreferrer">
                <Icon name="link" /> See it on Stellar Expert
              </a>
            )}
            <BigButton tone="leaf" className="w-full" onClick={onClose}>
              <Y k="close" sub="text-white/85" />
            </BigButton>
          </div>
        )}

        {phase === 'failed' && (
          <div className="mt-6 space-y-4">
            {message && <Notice tone="chili">{message}</Notice>}
            <BigButton tone="sand" className="w-full" onClick={onClose}>
              <Y k="close" />
            </BigButton>
          </div>
        )}

        {(phase === 'ask' || phase === 'working') && (
          <div className="mt-6 space-y-4">
            {message && <Notice tone="chili">{message}</Notice>}
            {pinNeeded && (
              <>
                <p className="text-center text-xl font-bold">
                  <Icon name="lock" /> <Y k="typePin" />
                </p>
                <PinDots length={pin.length} />
                <Keypad onKey={(k) => setPin((p) => applyKey(p, k, 6, true))} />
                <p className="text-center text-base text-ink-soft">{W.pinHidden.en}</p>
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <BigButton tone="white" className="min-h-24 text-2xl" onClick={no} disabled={phase === 'working'}>
                <Icon name="x" /> <Y k="no" />
              </BigButton>
              <BigButton tone="leaf" className="min-h-24 text-2xl" onClick={yes} disabled={phase === 'working' || (pinNeeded && pin.length < 4)}>
                {phase === 'working' ? 'One moment…' : (
                  <>
                    <Icon name="check" /> <Y k="yes" sub="text-white/85" />
                  </>
                )}
              </BigButton>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function CodeBox({ code }: { code: string }) {
  return (
    <div className="rounded-3xl border-4 border-dashed border-brick bg-white px-4 py-5">
      <p className="text-lg font-bold">
        <Y k="showCode" />
      </p>
      <p className="mt-2 font-mono text-6xl font-extrabold tracking-[0.2em] text-ink" aria-label={code.split('').join(' ')}>
        {code.slice(0, 3)} {code.slice(3)}
      </p>
    </div>
  )
}
