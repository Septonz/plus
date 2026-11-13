// The India confirm sheet, used by voice and taps alike. It opens by itself when a pending action
// she started (by voice or by tapping) arrives through Realtime. Amount large, who it's to (English,
// Tamil beneath), Yes and No, and the PIN pad above the PIN threshold. The PIN goes straight from
// here to agent-tools (confirm_action, app channel); it never passes through the voice agent.
import { useState } from 'react'
import { getMarket } from '@plus/markets'
import { ConfirmSheet as Sheet, type ConfirmPhase, type CostLine } from '../ds/ConfirmSheet'
import { tool, type ToolResult } from './api'
import { money, needsPin, type PendingAction } from './data'
import { PAYEE_TA, T } from './i18n'
import { useSays } from './screen'
import { useLang, useT } from './ui'

function readback(a: PendingAction): { to: string | null; toTa: string | null; lines: CostLine[] } {
  const amount = a.params.amount !== undefined ? BigInt(String(a.params.amount)) : null
  const total: CostLine[] = amount !== null ? [{ label: 'Fee', value: money(0n) }, { label: 'Total', value: money(amount), strong: true }] : []
  if (a.kind === 'pay') {
    const name = String(a.params.payee_name ?? '')
    return { to: `To ${name}`, toTa: `${PAYEE_TA[name] ?? name}க்கு`, lines: total }
  }
  if (a.kind === 'confirm_cash_in') {
    const h = String(a.params.helper_name ?? 'Helper')
    return { to: `Cash you gave ${h}`, toTa: `${h} கிட்ட கையில கொடுத்தது`, lines: [] }
  }
  if (a.kind === 'advance') {
    const fee = BigInt(String(a.params.fee ?? 0))
    return {
      to: 'Advance', toTa: 'முன்பணம்',
      lines: [
        { label: 'You receive', value: money(amount ?? 0n) },
        { label: 'One fee', value: money(fee) },
        { label: 'Total to pay back', value: money((amount ?? 0n) + fee), strong: true },
      ],
    }
  }
  return { to: null, toTa: null, lines: [] }
}

export function ConfirmSheet({ action, onClose }: { action: PendingAction; onClose: () => void }) {
  const t = useT()
  const { lang } = useLang()
  const pinNeeded = needsPin(action)
  const [pin, setPin] = useState('')
  const [phase, setPhase] = useState<ConfirmPhase>('ask')
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ToolResult | null>(null)
  useSays(
    phase === 'done' ? `Done: ${action.readback}.`
      : phase === 'working' ? `Confirming: ${action.readback}.`
      : phase === 'failed' ? `Confirm sheet: ${message ?? 'it did not go through'}. A Close button.`
      : `Confirm sheet: ${action.readback}. ` + (pinNeeded
        ? `Above ${money(BigInt(getMarket('in').pinThreshold) * 100n)}: she types her PIN on the screen, then Yes. Never ask for the PIN out loud.`
        : 'She can tap Yes or say yes, or No to cancel.'),
  )

  async function yes() {
    setPhase('working')
    setMessage(null)
    const r = await tool('confirm_action', pinNeeded ? { action_id: action.id, pin } : { action_id: action.id }).catch(
      () => ({ text: '', ok: false, error: 'network' }) as ToolResult,
    )
    setPin('')
    if (r.status === 'done') {
      setResult(r)
      setPhase('done')
      return
    }
    setPhase(r.status === 'failed' || r.status === 'expired' || r.status === 'rejected' ? 'failed' : 'ask')
    setMessage(pinMessage(r, lang))
  }

  async function no() {
    setPhase('working')
    await tool('reject_action', { action_id: action.id }).catch(() => null)
    setPhase('failed')
    setMessage(t('cancelled'))
  }

  const rb = readback(action)
  const ta = lang === 'ta'
  const autoSave = action.kind === 'set_auto_save'
  const both = (k: keyof typeof T) => (ta ? `${T[k].en} · ${T[k].ta}` : T[k].en)
  return (
    <Sheet
      phase={phase}
      heading={both('checkThis')}
      amount={action.params.amount !== undefined ? money(String(action.params.amount)) : null}
      big={autoSave ? <p className="num text-6xl font-light">{String(action.params.percent)}%</p> : undefined}
      to={autoSave ? T.autoSave.en : rb.to}
      toSub={autoSave ? (ta ? T.autoSave.ta : T.autoSaveHelp.en) : ta ? rb.toTa : undefined}
      lines={rb.lines}
      pinNeeded={pinNeeded}
      pin={pin}
      onPin={setPin}
      pinLabel={both('typePin')}
      pinHint={both('pinHidden')}
      yes={both('yes')}
      no={both('no')}
      working={T.working.en}
      closeLabel={both('close')}
      onYes={() => void yes()}
      onNo={() => void no()}
      onClose={onClose}
      message={message}
      done={
        typeof result?.balance_text === 'string' ? (
          <p className="text-base text-secondary">
            {T.toSpend.en}{ta ? ` · ${T.toSpend.ta}` : ''} <span className="num block text-3xl font-light text-label">{result.balance_text}</span>
          </p>
        ) : null
      }
    />
  )
}

function pinMessage(r: ToolResult, lang: 'ta' | 'en'): string {
  switch (r.error) {
    case 'pin_wrong':
      return lang === 'ta' ? `PIN தப்பு. இன்னும் ${String(r.attempts_left)} முறை போடலாம்.` : `Wrong PIN. ${String(r.attempts_left)} tries left.`
    case 'pin_locked':
      return lang === 'ta' ? 'நிறைய தடவை தப்பு. 15 நிமிஷம் கழிச்சு முயற்சி பண்ணுங்க.' : 'Too many wrong PINs. Try again in 15 minutes.'
    case 'pin_not_set':
      return lang === 'ta' ? 'முதல்ல அமைப்புல PIN வையுங்க.' : 'Set a PIN in Settings first.'
    case 'network':
      return lang === 'ta' ? 'இணைப்பு இல்ல. மறுபடியும் தொடுங்க.' : 'No connection. Tap again.'
    default:
      return r.result && (r.result as { error?: string }).error === 'insufficient_funds'
        ? lang === 'ta' ? 'போதுமான பணம் இல்ல.' : 'Not enough money.'
        : r.text || (lang === 'ta' ? 'நடக்கல. மறுபடியும் முயற்சி பண்ணுங்க.' : "It didn't go through. Try again.")
  }
}
