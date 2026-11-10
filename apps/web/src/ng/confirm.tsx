// Nigeria confirm sheet: the read-back, Yes / No, and the PIN pad above the market's PIN threshold
// (typed here, never spoken). After Yes, confirm_action answers "sending" at once; the sheet then
// waits for the transaction row to turn completed (chain-worker saw it in a closed ledger) and
// shows the tick, the seconds it took and the "Verified on Stellar" link. A cash-out shows its code
// once. Paying a phone number that is not on Plus shows the text message they get (simulated on the
// demo); paying a new phone number offers "Save this person" afterwards.
import { useEffect, useRef, useState } from 'react'
import { getMarket } from '@plus/markets'
import { ConfirmSheet, type ConfirmPhase, type CostLine } from '../ds/ConfirmSheet'
import { Button, Icon, Notice, VerifiedMark } from '../ds/components'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, Tx } from '../plus/data'
import { SmsBubble } from '../plus/ui'
import { forScreen, naira, W } from './words'

const EXPLORER = 'https://stellar.expert/explorer/testnet'
const NG = getMarket('ng')

const localNg = (p: string) => (p.startsWith('+234') ? `0${p.slice(4, 7)} ${p.slice(7, 10)} ${p.slice(10)}` : p)

export function ngNeedsPin(a: PendingAction): boolean {
  if (!['pay', 'pay_code', 'group_contribution', 'cash_out'].includes(a.kind)) return false
  return BigInt(String(a.params.amount ?? 0)) > BigInt(NG.pinThreshold) * 100n
}

function to(a: PendingAction): string {
  const p = a.params
  switch (a.kind) {
    case 'pay':
      return `To ${String(p.payee_name ?? '')}`
    case 'pay_code':
      return `To ${String(p.payee_name ?? '')}, by code`
    case 'group_contribution':
      return `To ${String(p.group_name ?? 'your ajo')}`
    case 'advance':
      return 'Advance into your wallet'
    case 'cash_out':
      return 'Cash out with an agent'
    case 'confirm_cash_in':
      return `Cash you gave ${String(p.helper_name ?? 'the agent')}`
    default:
      return ''
  }
}

function costLines(a: PendingAction): CostLine[] {
  const p = a.params
  const amount = p.amount !== undefined ? BigInt(String(p.amount)) : null
  if (a.kind === 'advance') {
    const fee = BigInt(String(p.fee ?? 0))
    return [
      { label: 'You receive', value: naira(amount ?? 0n) },
      { label: 'One fee', value: naira(fee) },
      { label: 'Total to pay back', value: naira((amount ?? 0n) + fee), strong: true },
      { label: `Pays back by itself: ${NG.advance.repayFromCashInBps / 100}% of each cash-in. No interest, no late fees.` },
    ]
  }
  if (a.kind === 'pay' || a.kind === 'pay_code' || a.kind === 'group_contribution' || a.kind === 'cash_out') {
    return [{ label: 'Fee', value: naira(0n) }, { label: 'Total', value: naira(amount ?? 0n), strong: true }]
  }
  return []
}

export function NgConfirmSheet({ action, txs, onClose }: { action: PendingAction; txs: Tx[]; onClose: () => void }) {
  const pinNeeded = ngNeedsPin(action)
  const [pin, setPin] = useState('')
  const [phase, setPhase] = useState<ConfirmPhase>('ask')
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ToolResult | null>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const t0 = useRef(0)

  const txId = typeof result?.transaction_id === 'string' ? result.transaction_id : null
  const tx = txId ? txs.find((t) => t.id === txId) : undefined
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
    setMessage(r.text ? forScreen(r.text) : "It didn't go through. Try again.")
  }

  async function no() {
    setPhase('working')
    await tool('reject_action', { action_id: action.id }).catch(() => null)
    setMessage(action.kind === 'confirm_cash_in' ? 'Okay. That cash is marked as not received.' : 'Okay, cancelled. Nothing was sent.')
    setPhase('failed')
  }

  const code = typeof result?.cash_out_code === 'string' ? result.cash_out_code : null
  const sms = (result?.pay_code_sms ?? null) as { to: string; code: string; text: string } | null
  const phone = typeof action.params.phone === 'string' ? action.params.phone : null
  const canSave = Boolean(phone) && !action.params.payee_id && (action.kind === 'pay' || action.kind === 'pay_code')
  const amount = action.params.amount !== undefined ? naira(String(action.params.amount)) : null
  const extras = (
    <>
      {code && <CodeBox code={code} />}
      {sms && <div className="text-left"><SmsBubble to={localNg(sms.to)} text={sms.text} /></div>}
    </>
  )

  let info: string | null = null
  if (action.kind === 'cash_out') info = 'You get a code. Show it to the agent and collect your cash.'
  else if (action.kind === 'pay_code') info = 'They are not on Plus yet. They get a text with a code and collect the cash at any Plus agent. Unused after 7 days, it comes back to you.'
  else if (action.kind === 'pay' && action.params.to_user_id) info = 'On Plus: straight to their wallet.'

  return (
    <ConfirmSheet
      phase={phase}
      heading={action.kind === 'confirm_cash_in' ? W.isThatRight.en : W.checkThis.en}
      amount={amount}
      to={to(action)}
      toSub={phone && phase !== 'done' ? localNg(phone) : undefined}
      lines={costLines(action)}
      info={info}
      pinNeeded={pinNeeded}
      pin={pin}
      onPin={setPin}
      pinLabel={W.typePin.en}
      pinHint={W.pinHidden.en}
      yes={W.yes.en}
      no={W.no.en}
      closeLabel={W.close.en}
      onYes={() => void yes()}
      onNo={() => void no()}
      onClose={onClose}
      message={message}
      sending={<>{extras}<p className="text-base text-secondary">{result?.text}</p></>}
      done={
        <>
          {extras}
          <div className="flex flex-col items-center gap-1">
            <VerifiedMark url={tx?.chain_tx_hash ? `${EXPLORER}/tx/${tx.chain_tx_hash}` : null} />
            {seconds !== null && <span className="text-sm text-secondary">in {seconds.toFixed(1)} seconds</span>}
          </div>
          {canSave && <SaveThisPerson name={String(action.params.payee_name ?? '')} phone={phone!} />}
        </>
      }
    />
  )
}

/** After paying a new phone number: keep them as a payee for next time. */
function SaveThisPerson({ name, phone }: { name: string; phone: string }) {
  const [state, setState] = useState<'ask' | 'saving' | 'saved' | 'failed'>('ask')
  const [text, setText] = useState('')
  if (state === 'saved') return <Notice tone="success">{text || `Saved ${name}. Next time, pick them from Saved people.`}</Notice>
  return (
    <div className="space-y-2">
      {state === 'failed' && <Notice tone="danger">{text}</Notice>}
      <Button variant="plain" className="w-full" loading={state === 'saving'} onClick={async () => {
        setState('saving')
        const r = await tool('save_payee', { name, phone }).catch(() => ({ text: 'No connection. Try again.', ok: false }) as ToolResult)
        setText(r.text)
        setState(r.ok ? 'saved' : 'failed')
      }}>
        <Icon name="userPlus" /> {W.saveThisPerson.en}
      </Button>
    </div>
  )
}

export function CodeBox({ code }: { code: string }) {
  return (
    <div className="rounded-card border border-dashed border-fill-strong bg-surface-2 px-4 py-5 text-center">
      <p className="text-sm font-medium text-secondary">{W.showCode.en}</p>
      <p className="num mt-2 font-mono text-5xl font-light tracking-[0.18em] text-label" aria-label={code.split('').join(' ')}>
        {code.slice(0, 3)} {code.slice(3)}
      </p>
    </div>
  )
}
