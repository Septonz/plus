// The confirm screen, used by voice and taps alike. It opens by itself when a pending action she
// started (by voice or by tapping) arrives through Realtime. Big read-back, Yes and No, and an
// on-screen PIN pad above the PIN threshold. The PIN goes straight from here to agent-tools
// (confirm_action, app channel); it never passes through the voice agent.
import { useState } from 'react'
import { tool, type ToolResult } from './api'
import { money, needsPin, type PendingAction } from './data'
import { PAYEE_TA, T } from './i18n'
import { applyKey, BigButton, Icon, Keypad, L, Notice, PinDots, useLang, useT } from './ui'

export function Readback({ a }: { a: PendingAction }) {
  const { lang } = useLang()
  const amount = a.params.amount !== undefined ? money(String(a.params.amount)) : null
  let to: { ta: string; en: string } | null = null
  if (a.kind === 'pay') {
    const name = String(a.params.payee_name ?? '')
    to = { ta: `${PAYEE_TA[name] ?? name}க்கு`, en: `to ${name}` }
  } else if (a.kind === 'group_contribution') {
    to = { ta: 'உங்க சீட்டுக்கு', en: 'to your seettu' }
  } else if (a.kind === 'confirm_cash_in') {
    const h = String(a.params.helper_name ?? 'Helper')
    to = { ta: `${h} கிட்ட கையில கொடுத்தது`, en: `cash you gave ${h}` }
  }
  if (a.kind === 'set_auto_save') {
    return (
      <div className="text-center">
        <p className="text-6xl font-extrabold text-brick">{String(a.params.percent)}%</p>
        <p className="mt-2 text-2xl font-bold">
          <L k="autoSave" />
        </p>
        <p className="mt-1 text-lg text-ink-soft">{lang === 'ta' ? T.autoSaveHelp.ta : T.autoSaveHelp.en}</p>
      </div>
    )
  }
  return (
    <div className="text-center">
      {amount && <p className="text-6xl font-extrabold tracking-tight text-brick">{amount}</p>}
      {to && (
        <p className="mt-3 text-2xl font-bold">
          {lang === 'ta' ? (
            <>
              {to.ta}
              <span className="block text-lg font-normal text-ink-soft">{to.en}</span>
            </>
          ) : (
            to.en
          )}
        </p>
      )}
    </div>
  )
}

type Phase = 'ask' | 'working' | 'done' | 'failed'

export function ConfirmSheet({ action, onClose }: { action: PendingAction; onClose: () => void }) {
  const t = useT()
  const { lang } = useLang()
  const pinNeeded = needsPin(action)
  const [pin, setPin] = useState('')
  const [phase, setPhase] = useState<Phase>('ask')
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ToolResult | null>(null)

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
    setResult({ text: t('cancelled') })
    setPhase('failed')
    setMessage(t('cancelled'))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="sheet-in max-h-[100dvh] w-full max-w-md overflow-y-auto rounded-t-[2rem] bg-cream px-5 pb-8 pt-6 sm:rounded-[2rem]">
        <h2 id="confirm-title" className="mb-4 text-center text-2xl font-extrabold">
          {phase === 'done' ? <L k="done" /> : <L k="checkThis" />}
        </h2>

        <Readback a={action} />

        {phase === 'done' && (
          <div className="mt-6 space-y-4 text-center">
            <p className="mx-auto grid size-20 place-items-center rounded-full bg-leaf text-5xl text-white">
              <Icon name="check" />
            </p>
            {typeof result?.balance_text === 'string' && (
              <p className="text-xl">
                <L k="toSpend" className="items-center" /> <span className="block text-3xl font-extrabold">{result.balance_text}</span>
              </p>
            )}
            <BigButton tone="leaf" className="w-full" onClick={onClose}>
              <L k="close" sub="text-white/85" />
            </BigButton>
          </div>
        )}

        {phase === 'failed' && (
          <div className="mt-6 space-y-4">
            {message && <Notice tone="chili">{message}</Notice>}
            <BigButton tone="sand" className="w-full" onClick={onClose}>
              <L k="close" />
            </BigButton>
          </div>
        )}

        {(phase === 'ask' || phase === 'working') && (
          <div className="mt-6 space-y-4">
            {message && <Notice tone="chili">{message}</Notice>}
            {pinNeeded ? (
              <>
                <p className="text-center text-xl font-bold">
                  <Icon name="lock" /> <L k="typePin" />
                </p>
                <PinDots length={pin.length} />
                <Keypad onKey={(k) => setPin((p) => applyKey(p, k, 6, true))} />
                <p className="text-center text-base text-ink-soft">{t('pinHidden')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <BigButton tone="white" onClick={no} disabled={phase === 'working'}>
                    <L k="no" />
                  </BigButton>
                  <BigButton tone="leaf" onClick={yes} disabled={phase === 'working' || pin.length < 4}>
                    {phase === 'working' ? t('working') : <L k="yes" sub="text-white/85" />}
                  </BigButton>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <BigButton tone="white" className="min-h-24 text-2xl" onClick={no} disabled={phase === 'working'}>
                  <Icon name="x" /> <L k="no" />
                </BigButton>
                <BigButton tone="leaf" className="min-h-24 text-2xl" onClick={yes} disabled={phase === 'working'}>
                  {phase === 'working' ? t('working') : (
                    <>
                      <Icon name="check" /> <L k="yes" sub="text-white/85" />
                    </>
                  )}
                </BigButton>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
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
