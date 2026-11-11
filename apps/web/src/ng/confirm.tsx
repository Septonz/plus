// Nigeria confirm sheet: the read-back, Yes / No, and the PIN pad above the market's PIN threshold
// (typed here, never spoken). After Yes, confirm_action answers "sending" at once; the sheet then
// waits for the transaction row to turn completed (chain-worker saw it in a closed ledger) and
// shows the tick, the seconds it took and the "Verified on Stellar" link. A cash-out shows its code
// once. Paying a phone number that is not on Plus shows the text message they get (simulated on the
// demo); paying a new phone number offers "Save this person" afterwards.
import { formatTime } from '../lib/time'
import { useEffect, useRef, useState } from 'react'
import { getMarket } from '@plus/markets'
import { ConfirmSheet, type ConfirmPhase, type CostLine } from '../ds/ConfirmSheet'
import { Button, Icon, Notice, VerifiedMark } from '../ds/components'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, Tx } from '../plus/data'
import { useSays } from '../plus/screen'
import { SmsBubble } from '../plus/ui'
import { forScreen, naira, W } from './words'

const EXPLORER = 'https://stellar.expert/explorer/testnet'
const NG = getMarket('ng')

const localNg = (p: string) => (p.startsWith('+234') ? `0${p.slice(4, 7)} ${p.slice(7, 10)} ${p.slice(10)}` : p)

/** Same rule as the server (tools-ng.ts): a spoken or tapped Yes up to ₦5,000, the PIN above. A loan always takes the PIN. */
export function ngNeedsPin(a: PendingAction): boolean {
  if (a.kind === 'loan' || a.kind === 'record_share' || a.kind === 'vouch') return true
  if (!['pay', 'pay_code', 'group_contribution', 'cash_out', 'advance', 'loan_repay', 'bank_send'].includes(a.kind)) return false
  return BigInt(String(a.params.amount ?? 0)) > BigInt(NG.pinThreshold) * 100n
}

function to(a: PendingAction): string {
  const p = a.params
  switch (a.kind) {
    case 'pay':
      return `To ${String(p.payee_name ?? '')}`
    case 'pay_code':
      return `To ${String(p.payee_name ?? '')}, by code`
    case 'bank_send':
      return `To ${String(p.account_name ?? '')}`
    case 'group_contribution':
      return `To ${String(p.group_name ?? 'your ajo')}`
    case 'advance':
      return 'Advance into your wallet'
    case 'loan':
      return `From ${NG.lending?.lenderLabel ?? 'the partner lender'} to your wallet`
    case 'loan_repay':
      return 'To your loan'
    case 'loan_extension':
      return 'More time on your loan'
    case 'loan_restructure':
      return 'Smaller loan payments'
    case 'cash_out':
      return 'Cash out with an agent'
    case 'confirm_cash_in':
      return `Cash you gave ${String(p.helper_name ?? 'the agent')}`
    case 'record_share':
      return 'Share your record with a lender'
    case 'vouch':
      return `Vouch for ${String(p.borrower_name ?? 'an ajo member')}'s next loan`
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
  if (a.kind === 'loan') {
    const L = NG.lending!
    return [
      { label: W.youReceive.en, value: naira(amount ?? 0n) },
      { label: 'Cost', value: naira(String(p.cost ?? 0)) },
      { label: 'Total to repay', value: naira(String(p.total ?? 0)), strong: true },
      { label: `Repay ${L.repay.fromMoneyInBps / 100}% of every money-in, and at least ${naira(String(p.minimum ?? 0))} every two weeks. ${W.nobodyElse.en}` },
    ]
  }
  if (a.kind === 'loan_extension') {
    return [
      { label: 'Next payment due', value: new Date(String(p.new_due_at)).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }), strong: true },
      { label: 'Extra cost', value: naira(0n) },
      { label: 'New borrowing pauses until this loan is repaid.' },
    ]
  }
  if (a.kind === 'loan_restructure') {
    return [
      { label: 'Every two weeks, at least', value: naira(String(p.minimum ?? 0)), strong: true },
      { label: 'Extra cost', value: naira(0n) },
    ]
  }
  if (a.kind === 'pay' || a.kind === 'pay_code' || a.kind === 'group_contribution' || a.kind === 'cash_out' || a.kind === 'loan_repay' || a.kind === 'bank_send') {
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

  useSays(
    phase === 'done' ? `Done: ${action.readback}. The tick shows; verified on Stellar${seconds !== null ? ` in ${seconds.toFixed(1)} seconds` : ''}.`
      : phase === 'sending' || phase === 'working' ? `Sending on Stellar: ${action.readback}.`
      : phase === 'failed' ? `Confirm sheet: ${message ?? 'it did not go through'}. A Close button.`
      : `Confirm sheet: ${action.readback}. ` + (pinNeeded
        ? `Above ${naira(BigInt(NG.pinThreshold) * 100n)}: she types her PIN on the screen, then Yes. Never ask for the PIN out loud.`
        : 'She can tap Yes or say yes, or No to cancel.'),
  )

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
      // More time or smaller payments move no money: there is no transaction to wait for.
      if (typeof r.transaction_id !== 'string') {
        setSeconds(null)
        setPhase('done')
      } else setPhase('sending')
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
  const shareCode = typeof result?.share_code === 'string' ? result.share_code : null
  const sms = (result?.pay_code_sms ?? null) as { to: string; code: string; text: string } | null
  const phone = typeof action.params.phone === 'string' ? action.params.phone : null
  const canSave = Boolean(phone) && !action.params.payee_id && (action.kind === 'pay' || action.kind === 'pay_code')
  const amount = action.params.amount !== undefined ? naira(String(action.params.amount)) : null
  const extras = (
    <>
      {code && <CodeBox code={code} />}
      {shareCode && <ShareCodeBox code={shareCode} expires={typeof result?.share_expires_at === 'string' ? result.share_expires_at : null} />}
      {sms && <div className="text-left"><SmsBubble to={localNg(sms.to)} text={sms.text} /></div>}
    </>
  )

  let info: string | null = null
  if (action.kind === 'cash_out') info = 'You get a code. Show it to the agent and collect your cash.'
  else if (action.kind === 'pay_code') info = 'They are not on Plus yet. They get a text with a code and collect the cash at any Plus agent. Unused after 7 days, it comes back to you.'
  else if (action.kind === 'pay' && action.params.to_user_id) info = 'On Plus: straight to their wallet.'
  else if (action.kind === 'bank_send') info = `${String(action.params.bank_name)}, account •••• ${String(action.params.account_number).slice(-4)}${action.params.payee_name !== action.params.account_name ? ` (${String(action.params.payee_name)})` : ''}. Sent on Stellar to the partner bank, which pays the account (simulated).`
  else if (action.kind === 'loan') info = 'Sent on Stellar from the partner lender account (simulated on Testnet).'
  else if (action.kind === 'vouch') info = `Recorded on Stellar as a reference, never your name. No money is ever taken from you. If ${String(action.params.borrower_name ?? 'they')} doesn't repay, you can't vouch for anyone for 6 months.`
  else if (action.kind === 'record_share') info = `The lender sees, read from Stellar: ${((action.params.shared ?? []) as string[]).join('; ')}. Never your name, phone number, ID or photos. One code, for one lender, for 24 hours. You can revoke it any time.`

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
            {txId && <VerifiedMark url={tx?.chain_tx_hash ? `${EXPLORER}/tx/${tx.chain_tx_hash}` : null} />}
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

/** Her record share code: she gives it to the lender, who types it on /verify. */
export function ShareCodeBox({ code, expires }: { code: string; expires: string | null }) {
  const until = expires ? formatTime(expires, { weekday: 'short' }) : null
  return (
    <div className="rounded-card border border-dashed border-fill-strong bg-surface-2 px-4 py-5 text-center">
      <p className="text-sm font-medium text-secondary">Give this code to the lender</p>
      <p className="num mt-2 font-mono text-4xl font-light tracking-[0.12em] text-label" aria-label={code.replace('-', '').split('').join(' ')}>{code}</p>
      <p className="mt-2 text-sm text-secondary">They open <b>{window.location.host}/verify</b> and type it.{until ? ` It works until ${until}, for one lender.` : ''}</p>
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
