// Sign-up: one flow for the app ("Open a Plus account"), Mama Bisi's agent page ("Register a
// customer", the customer answers on the agent's screen) and, later, a kiosk (the same screen on a
// shared tablet). Every step calls the same onboarding tools as the voice agent, with the signed
// onboarding token; the screen polls onboarding_status, so whatever the voice agent fills in shows
// here as it happens. The PIN, the NIN and the photo are only ever on this screen.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatMoney, getMarket, type MarketId } from '@plus/markets'
import { supabase } from '../lib/supabase'
import { tool, type ToolResult } from '../plus/api'
import { applyKey, BigButton, Card, CopyButton, Icon, Keypad, Notice, PinDots, SmsBubble, Spinner, SuccessTick, TextField } from '../plus/ui'
import { VoiceButton } from '../plus/voice'
import { MIC_WORDS, W, Y, type WKey } from '../ng/words'
import { ArtHello, ArtId, ArtLock, ArtPeople, ArtPhone, ArtSelfie, ArtWallet, ArtWelcome } from './art'

type Step = 'name' | 'language' | 'phone' | 'pin' | 'verify' | 'wallet'
type Status = ToolResult & {
  onboarding_id: string
  market: MarketId
  current: Step | 'done'
  steps: { step: Step; done: boolean }[]
  name: string | null
  language: string | null
  languages: { code: string; label: string }[]
  phone: string | null
  phone_hint: string
  code_sent: boolean
  has_pin: boolean
  selfie_passed: boolean
  id_document: { name: string; digits: number } | null
  id_last4: string | null
  tier: number
  limits: { tier: number; daily_text: string | null; balance_text: string | null; advances: boolean }
  trusted_contact: { name: string | null; phone: string } | null
  wallet: { status: string; address?: string | null; account_url?: string | null; tx_url?: string | null; virtual_account?: string | null; bank_label: string | null }
  finished: boolean
  onboarding_token?: string
}
type Sms = { to: string; code: string; text: string }

/** What the person reads on her own screen for each refusal (the tools' texts are for the voice agent). */
const SCREEN_TEXT: Record<string, string> = {
  invalid_name: 'Type your name, please (letters only).',
  invalid_language: 'Choose one of these languages.',
  invalid_phone: 'That phone number does not look right. Check it and try again.',
  phone_taken: 'That number already has a Plus account. Go back and use “I have an account”.',
  own_number: 'That is your own number. Choose someone else you trust.',
  code_expired: 'That code has expired. Tap “Send a new code”.',
  too_many_codes: 'Too many codes sent. Wait a little, then try again.',
  too_many_attempts: 'Too many wrong codes. Tap “Send a new code”.',
  no_code: 'Tap “Send me a code” first.',
  invalid_pin: 'Your PIN is 4 to 6 numbers.',
  weak_pin: 'That PIN is too easy to guess. Choose numbers that are not all the same or in a row.',
  invalid_id_number: 'Check the number and type it again.',
  id_not_found: 'The NIN registry did not find that number. Nothing was saved. Check it and type it again.',
  network: 'No connection. Try again.',
}
const screenText = (r: { error?: string; text: string }) =>
  (r.error && SCREEN_TEXT[r.error]) || r.text.replace(/\bAsk her to\b/g, 'Please').replace(/\bher\b/g, 'your').replace(/\bshe\b/g, 'you')

const STEP_META: Record<Step, [string, WKey]> = {
  name: ['person', 'stepName'],
  language: ['globe', 'stepLanguage'],
  phone: ['phone', 'stepPhone'],
  pin: ['lock', 'stepPin'],
  verify: ['shield', 'stepVerify'],
  wallet: ['wallet', 'stepWallet'],
}

const local = (e164: string | null) => {
  if (!e164) return ''
  if (e164.startsWith('+234')) return `0${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}`
  if (e164.startsWith('+91')) return `${e164.slice(3, 8)} ${e164.slice(8)}`
  return e164
}

/** The six steps, ticked off as they are done (by taps or by the voice agent). */
function StepTrack({ st, note }: { st: Status; note?: string }) {
  const i = st.current === 'done' ? st.steps.length : st.steps.findIndex((s) => s.step === st.current)
  const label = note ?? (st.current === 'done' ? 'All steps done' : W[STEP_META[st.current][1]].en)
  return (
    <div>
      <ol className="flex items-center justify-between" aria-label="Sign-up steps">
        {st.steps.map((s, n) => {
          const [icon, k] = STEP_META[s.step]
          const current = s.step === st.current
          return (
            <li key={s.step} className="flex flex-1 items-center last:flex-none">
              <span
                aria-label={`${W[k].en}: ${s.done ? 'done' : current ? 'now' : 'to do'}`}
                aria-current={current ? 'step' : undefined}
                className={`grid size-10 shrink-0 place-items-center rounded-full text-xl transition ${
                  s.done ? 'bg-success text-white' : current ? 'bg-accent text-on-accent ring-4 ring-warning/50' : 'bg-fill text-secondary'
                }`}
              >
                <Icon name={s.done ? 'check' : icon} />
              </span>
              {n < st.steps.length - 1 && <span className={`mx-1 h-1 flex-1 rounded-full ${s.done ? 'bg-success' : 'bg-fill-strong'}`} />}
            </li>
          )
        })}
      </ol>
      <p className="mt-2 text-lg font-semibold text-secondary" aria-live="polite">
        {st.current === 'done' ? label : `Step ${i + 1} of ${st.steps.length} · ${label}`}
      </p>
    </div>
  )
}

/** One step: an illustration, a title (English with Yoruba under it), why it matters, the controls. */
function Panel({ art, k, title, why, children }: { art: ReactNode; k?: WKey; title?: string; why: ReactNode; children: ReactNode }) {
  return (
    <section className="sheet-in space-y-4">
      {art}
      <h2 className="text-3xl font-semibold">{k ? <Y k={k} /> : title}</h2>
      <p className="flex gap-2 text-lg text-secondary">
        <Icon name="info" className="mt-1 text-xl text-info" />
        <span>{why}</span>
      </p>
      {children}
    </section>
  )
}

function Digits({ value, length, group = [] }: { value: string; length: number; group?: number[] }) {
  const cells = Array.from({ length }, (_, i) => value[i] ?? '')
  return (
    <div className="flex justify-center gap-1" aria-live="polite" aria-label={`${value.length} of ${length} numbers typed`}>
      {cells.map((c, i) => (
        <span
          key={i}
          className={`grid h-14 max-w-10 min-w-0 flex-1 place-items-center rounded-lg border-2 font-mono font-semibold ${length > 8 ? 'text-2xl' : 'text-3xl'} ${c ? 'border-accent bg-surface' : 'border-hairline bg-canvas'} ${group.includes(i) ? 'ml-1.5' : ''}`}
        >
          {c}
        </span>
      ))}
    </div>
  )
}

export default function Onboarding({ mode, onExit }: { mode: 'app' | 'agent'; onExit: () => void }) {
  const [market, setMarket] = useState<MarketId>('ng')
  const [token, setToken] = useState<string | null>(null)
  const [st, setSt] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [sms, setSms] = useState<Sms | null>(null)
  const [editPhone, setEditPhone] = useState(false)
  const [ninSkipped, setNinSkipped] = useState(false)
  const [trustedSkipped, setTrustedSkipped] = useState(false)
  const [agentDone, setAgentDone] = useState<string | null>(null)
  const [walletSince, setWalletSince] = useState(0)

  const call = useCallback(
    async (name: string, args: Record<string, unknown> = {}) => {
      setBusy(true)
      setMsg(null)
      const r = (await tool(name, { ...args, onboarding_token: token }).catch(() => ({ text: 'No connection. Try again.', ok: false, error: 'network' }))) as Status
      setBusy(false)
      if (r.ok === false) setMsg(r.error === 'wrong_code' ? r.text : screenText(r))
      if (r.steps) setSt(r)
      return r
    },
    [token],
  )

  // Follow the voice agent (and the wallet on Stellar): poll the status. Fast while the wallet opens.
  const opening = Boolean(st && !['none', 'done', 'failed'].includes(st.wallet.status))
  useEffect(() => {
    if (!token || st?.finished) return
    const id = window.setInterval(() => {
      void tool('onboarding_status', { onboarding_token: token }).then((r) => {
        const s = r as Status
        if (s.steps) setSt(s)
      }).catch(() => undefined)
    }, opening ? 800 : 3000)
    return () => window.clearInterval(id)
  }, [token, opening, st?.finished])

  async function start() {
    setBusy(true)
    setMsg(null)
    const r = (await tool('start_onboarding', { market }).catch(() => ({ text: 'No connection. Try again.', ok: false }))) as Status
    setBusy(false)
    if (!r.onboarding_token) return setMsg(r.text || 'Sign-up is not available just now.')
    setToken(r.onboarding_token)
    setSt(r)
  }

  async function finish() {
    const r = await call('finish_onboarding')
    if (r.ok === false) return
    if (mode === 'agent') return setAgentDone(r.text)
    if (typeof r.sign_in_token === 'string' && supabase) {
      setBusy(true)
      const { error } = await supabase.auth.verifyOtp({ token_hash: r.sign_in_token, type: 'magiclink' })
      setBusy(false)
      if (error) setMsg('Your account is ready, but signing in failed. Use "I have an account" with your phone and PIN.')
    }
  }

  const voiceBody = useMemo(() => (token ? { onboarding_token: token } : undefined), [token])

  // ------------------------------------------------------------------ before it starts
  if (!token || !st) {
    return (
      <Shell mode={mode} onExit={onExit}>
        <section className="space-y-5">
          <ArtWelcome />
          <h1 className="text-3xl font-semibold">{mode === 'agent' ? 'Register a customer' : <Y k="openAccount" />}</h1>
          <ul className="space-y-3 text-lg">
            <Li icon="star4">It takes about two minutes{mode === 'app' ? ', by voice or by tapping' : ''}.</Li>
            <Li icon="phone">{mode === 'agent' ? 'She needs her phone with her: a code comes to it.' : 'Have your phone with you: a code comes to it.'}</Li>
            <Li icon="lock">{mode === 'agent' ? 'She types her PIN and NIN herself on this screen. Turn it to her and look away.' : 'Your PIN and NIN are typed on this screen. Never say them out loud.'}</Li>
            <Li icon="wallet">The wallet is free. Plus pays the Stellar setup cost.</Li>
          </ul>
          {mode === 'app' && (
            <div>
              <p className="text-lg font-semibold">Country</p>
              <div className="mt-2 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Country">
                {(['ng', 'in'] as const).map((id) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={market === id}
                    onClick={() => setMarket(id)}
                    className={`min-h-14 rounded-control border-2 text-xl font-semibold ${market === id ? 'border-accent bg-accent text-on-accent' : 'border-hairline bg-surface'}`}
                  >
                    {getMarket(id).country}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msg && <Notice tone="chili">{msg}</Notice>}
          <BigButton className="w-full" loading={busy} onClick={() => void start()}>
            {mode === 'agent' ? 'Start' : <Y k="openAccount" sub="text-on-accent/80" />}
          </BigButton>
          <p className="text-center text-base text-secondary">Testnet demo: simulated money, test phone numbers.</p>
        </section>
      </Shell>
    )
  }

  // ------------------------------------------------------------------ which panel
  const ng = st.market === 'ng'
  const idDoc = st.id_document
  const view =
    st.current === 'name' ? 'name'
    : st.current === 'language' ? 'language'
    : st.current === 'phone' ? (st.code_sent && !editPhone ? 'code' : 'phone')
    : st.current === 'pin' ? 'pin'
    : st.current === 'verify' ? 'selfie'
    : st.current === 'wallet'
      ? idDoc && st.tier < 2 && !ninSkipped && st.wallet.status === 'none' ? 'nin'
      : !st.trusted_contact && !trustedSkipped && st.wallet.status === 'none' ? 'trusted'
      : 'wallet'
    : 'ready'

  return (
    <Shell mode={mode} onExit={onExit} finished={st.finished || st.current === 'done'}>
      <div className="space-y-5">
        {!agentDone && <StepTrack st={st} note={view === 'nin' ? `Optional: your ${idDoc?.name ?? 'ID'}` : view === 'trusted' ? 'Optional: someone you trust' : undefined} />}
        {mode === 'app' && view !== 'ready' && (
          <Card className="py-3!">
            <VoiceButton size="inline" body={voiceBody} words={{ ...MIC_WORDS, mic: 'Sign up by voice: tap and talk' }} />
          </Card>
        )}

        {agentDone ? (
          <section className="space-y-5 text-center">
            <SuccessTick />
            <h2 className="text-3xl font-semibold">{st.name}'s account is ready</h2>
            <Notice tone="leaf">{agentDone}</Notice>
            <BigButton className="w-full" onClick={onExit}>Back to the agent page</BigButton>
          </section>
        ) : view === 'name' ? (
          <NameStep st={st} busy={busy} msg={msg} onSave={(name) => void call('set_profile', { name })} />
        ) : view === 'language' ? (
          <Panel art={<ArtHello />} k="whichLanguage" why="Plus talks to you in this language, and the screens follow it where they can.">
            <div className="grid gap-3">
              {st.languages.map((l) => (
                <button key={l.code} disabled={busy} onClick={() => void call('set_profile', { language: l.code })}
                  className="flex min-h-16 items-center justify-between rounded-control border-2 border-hairline bg-surface px-5 text-left text-2xl font-semibold active:bg-fill">
                  {l.label} <Icon name="pay" className="text-secondary" />
                </button>
              ))}
            </div>
            {msg && <Notice tone="chili">{msg}</Notice>}
          </Panel>
        ) : view === 'phone' ? (
          <PhoneStep st={st} busy={busy} msg={msg} onSend={async (phone) => {
            const r = await call('send_phone_code', { phone })
            if (r.ok !== false) {
              setEditPhone(false)
              setSms((r.demo_sms as Sms | undefined) ?? null)
            }
          }} />
        ) : view === 'code' ? (
          <CodeStep key={sms?.code ?? 'none'} st={st} sms={sms} busy={busy} msg={msg}
            onVerify={(code) => void call('verify_phone_code', { code })}
            onResend={async () => {
              const r = await call('send_phone_code', { phone: st.phone })
              if (r.ok !== false) setSms((r.demo_sms as Sms | undefined) ?? null)
            }}
            onChange={() => { setEditPhone(true); setSms(null); setMsg(null) }} />
        ) : view === 'pin' ? (
          <PinStep agent={mode === 'agent'} busy={busy} msg={msg} onSave={(pin) => void call('set_pin', { pin })} clear={() => setMsg(null)} />
        ) : view === 'selfie' ? (
          <SelfieStep busy={busy} msg={msg} onPass={() => void call('verify_identity', { selfie: 'passed' })} />
        ) : view === 'nin' && idDoc ? (
          <NinStep st={st} doc={idDoc} agent={mode === 'agent'} busy={busy} msg={msg} onCheck={(nin) => call('verify_identity', { nin })} onSkip={() => { setNinSkipped(true); setMsg(null) }} />
        ) : view === 'trusted' ? (
          <TrustedStep busy={busy} msg={msg} hint={st.phone_hint}
            onSave={(name, phone) => void call('set_trusted_contact', { name, phone })}
            onSkip={() => { setTrustedSkipped(true); setMsg(null) }} />
        ) : view === 'wallet' ? (
          <Panel art={<ArtWallet />} k={ng ? 'openWallet' : undefined} title={ng ? undefined : 'Open my account'}
            why={ng
              ? 'Your wallet is your own account on Stellar, a public payment network. Plus pays the setup cost. Your name is never written on it: only numbers.'
              : 'Plus opens your account with the partner bank (simulated). In India you never hold crypto; your money stays in rupees at the bank.'}>
            {st.wallet.status === 'none' || st.wallet.status === 'failed' ? (
              <>
                {st.wallet.status === 'failed' && <Notice tone="chili">Opening the wallet did not work. Nothing was charged. Try again.</Notice>}
                {msg && <Notice tone="chili">{msg}</Notice>}
                <BigButton tone="leaf" className="w-full" loading={busy} onClick={async () => {
                  setWalletSince(Date.now())
                  await call('create_wallet')
                }}>
                  <Icon name="wallet" /> {ng ? W.openWallet.en : 'Open my account'}
                </BigButton>
              </>
            ) : (
              <WalletOpening since={walletSince} />
            )}
          </Panel>
        ) : (
          <ReadyStep st={st} mode={mode} busy={busy} msg={msg} onFinish={() => void finish()} />
        )}
      </div>
    </Shell>
  )
}

function Li({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-fill text-xl text-accent-ink"><Icon name={icon} /></span>
      <span className="pt-1.5">{children}</span>
    </li>
  )
}

function Shell({ mode, onExit, finished, children }: { mode: 'app' | 'agent'; onExit: () => void; finished?: boolean; children: ReactNode }) {
  return (
    <div className={mode === 'app' ? 'mx-auto min-h-dvh max-w-md px-4 pb-16 pt-4' : ''}>
      <header className="flex items-center justify-between pb-4">
        <p className="text-base font-semibold uppercase tracking-wide text-warning-strong">{mode === 'agent' ? 'Register a customer' : 'New account'}</p>
        {!finished && (
          <button onClick={onExit} className="inline-flex min-h-12 items-center gap-1 rounded-full border-2 border-hairline bg-surface px-4 text-base font-semibold active:bg-fill">
            <Icon name="x" /> {mode === 'agent' ? 'Stop' : 'Leave'}
          </button>
        )}
      </header>
      {children}
    </div>
  )
}

function NameStep({ st, busy, msg, onSave }: { st: Status; busy: boolean; msg: string | null; onSave: (n: string) => void }) {
  const [name, setName] = useState(st.name ?? '')
  return (
    <Panel art={<ArtHello />} k="whatName" why="Plus greets you by this name, and people you pay see it on their receipt.">
      <TextField label="Your name" value={name} onChange={setName} placeholder="Adaeze Okafor" autoComplete="name" maxLength={60} />
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={name.trim().length < 2} onClick={() => onSave(name)}>
        <Y k="next" sub="text-on-accent/80" />
      </BigButton>
    </Panel>
  )
}

function PhoneStep({ st, busy, msg, onSend }: { st: Status; busy: boolean; msg: string | null; onSend: (p: string) => void }) {
  const [phone, setPhone] = useState(st.phone ? local(st.phone) : '')
  return (
    <Panel art={<ArtPhone />} k="yourPhone" why="Your number is how people pay you and how you sign in. We send a code to it to check it is really yours.">
      <TextField label="Phone number" value={phone} onChange={setPhone} inputMode="tel" placeholder={st.phone_hint} autoComplete="tel"
        hint={<>Demo: test numbers like <b>{st.phone_hint}</b> show their code on this screen.</>} />
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={phone.replace(/\D/g, '').length < 10} onClick={() => onSend(phone)}>
        <Icon name="sms" /> Send me a code
      </BigButton>
    </Panel>
  )
}

function CodeStep({ st, sms, busy, msg, onVerify, onResend, onChange }: {
  st: Status; sms: Sms | null; busy: boolean; msg: string | null; onVerify: (c: string) => void; onResend: () => void; onChange: () => void
}) {
  const [code, setCode] = useState('') // keyed by the code sent: a new code starts empty
  return (
    <Panel art={<ArtPhone />} k="typeCode" why={<>We sent 6 numbers to <b>{local(st.phone)}</b>. Typing them proves the phone is yours. Never give this code to anyone.</>}>
      {sms ? <SmsBubble to={local(sms.to)} text={sms.text} /> : <Notice tone="sky">The code was sent. Don't see it? Tap "Send a new code".</Notice>}
      <Digits value={code} length={6} />
      <Keypad onKey={(k) => {
        const next = applyKey(code, k, 6, true)
        setCode(next)
        if (next.length === 6 && code.length === 5) onVerify(next)
      }} />
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={code.length !== 6} onClick={() => onVerify(code)}>
        <Icon name="check" /> Check code
      </BigButton>
      <div className="grid grid-cols-2 gap-3">
        <button onClick={onResend} disabled={busy} className="min-h-12 rounded-control bg-fill text-lg font-semibold active:bg-fill-strong">Send a new code</button>
        <button onClick={onChange} disabled={busy} className="min-h-12 rounded-control bg-fill text-lg font-semibold active:bg-fill-strong">Change number</button>
      </div>
    </Panel>
  )
}

function PinStep({ agent, busy, msg, onSave, clear }: { agent: boolean; busy: boolean; msg: string | null; onSave: (p: string) => void; clear: () => void }) {
  const [first, setFirst] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const again = first !== null
  return (
    <Panel art={<ArtLock />} k={again ? 'pinAgain' : 'choosePin'}
      why="Your PIN protects bigger payments and signing in. Type it here only. Never say it out loud, not even to Plus.">
      {agent && <Notice tone="sky">Turn the screen to her. She types her PIN herself; look away.</Notice>}
      <PinDots length={pin.length} max={6} />
      <Keypad onKey={(k) => { setPin((p) => applyKey(p, k, 6, true)); setMismatch(false); clear() }} />
      {mismatch && <Notice tone="chili">The two PINs were different. Choose your PIN again.</Notice>}
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={pin.length < 4} onClick={() => {
        if (!again) {
          setFirst(pin)
          setPin('')
          return
        }
        if (pin !== first) {
          setFirst(null)
          setPin('')
          setMismatch(true)
          return
        }
        onSave(pin)
        setFirst(null)
        setPin('')
      }}>
        {again ? 'Save my PIN' : <Y k="next" sub="text-on-accent/80" />}
      </BigButton>
      <p className="text-center text-base text-secondary">4 to 6 numbers. Not all the same, not 1234.</p>
    </Panel>
  )
}

/**
 * The photo check (simulated liveness): the camera runs on this phone only. The photo is never
 * uploaded or stored; Plus keeps only "photo check passed".
 */
function SelfieStep({ busy, msg, onPass }: { busy: boolean; msg: string | null; onPass: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [cam, setCam] = useState<'off' | 'starting' | 'on' | 'none'>('off')
  const [phase, setPhase] = useState<'ready' | 'checking'>('ready')
  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }
  useEffect(() => stop, [])

  async function open() {
    setCam('starting')
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      stream.current = s
      setCam('on')
      window.setTimeout(() => {
        if (video.current) {
          video.current.srcObject = s
          void video.current.play().catch(() => undefined)
        }
      }, 0)
    } catch {
      setCam('none')
    }
  }

  function take() {
    // Freeze the picture for a moment, then drop it: nothing leaves this phone.
    video.current?.pause()
    stop()
    setPhase('checking')
    window.setTimeout(() => onPass(), 1400)
  }

  return (
    <Panel art={cam === 'on' ? null : <ArtSelfie />} k="takePhoto"
      why="A quick photo checks that a real person is opening this account. The photo stays on this phone: Plus keeps only “photo check passed”.">
      {cam === 'on' && (
        <div className="relative mx-auto aspect-square w-64 overflow-hidden rounded-full border-8 border-warning bg-scrim">
          <video ref={video} playsInline muted className="size-full -scale-x-100 object-cover" />
          {phase === 'checking' && (
            <div className="absolute inset-0 grid place-items-center bg-scrim/55 text-xl font-semibold text-white">
              <span className="flex items-center gap-2"><Spinner /> Checking…</span>
            </div>
          )}
        </div>
      )}
      {cam === 'none' && <Notice tone="sky">No camera here (or it was blocked). On this demo you can use the demo check instead.</Notice>}
      {msg && <Notice tone="chili">{msg}</Notice>}
      {cam === 'on' ? (
        <BigButton className="w-full" loading={busy || phase === 'checking'} onClick={take}><Icon name="camera" /> Take the photo</BigButton>
      ) : cam === 'none' ? (
        <BigButton className="w-full" loading={busy || phase === 'checking'} onClick={() => { setPhase('checking'); window.setTimeout(onPass, 900) }}>
          <Icon name="check" /> Use the demo check
        </BigButton>
      ) : (
        <BigButton className="w-full" loading={cam === 'starting'} onClick={() => void open()}><Icon name="camera" /> Open the camera</BigButton>
      )}
    </Panel>
  )
}

function NinStep({ st, doc, agent, busy, msg, onCheck, onSkip }: {
  st: Status; doc: { name: string; digits: number }; agent: boolean; busy: boolean; msg: string | null; onCheck: (n: string) => Promise<Status>; onSkip: () => void
}) {
  const [nin, setNin] = useState('')
  const m = getMarket(st.market)
  const t1 = m.kyc.tiers[1]
  const t2 = m.kyc.tiers[2]
  const money = (n: number) => formatMoney(BigInt(n) * 100n, st.market)
  return (
    <Panel art={<ArtId />} k="addNin" why={`Your ${doc.name} lets you send and keep more, and opens advances later. Type it here; never say it out loud. Plus keeps only the last 4 numbers and a scrambled check, never the whole number.`}>
      {agent && <Notice tone="sky">Turn the screen to her. She types her {doc.name} herself.</Notice>}
      <div className="grid grid-cols-2 gap-3 text-base">
        <div className="rounded-control bg-fill p-3">
          <p className="font-semibold">Now</p>
          <p>{money(t1.dailyLimit)} a day</p>
          <p>Hold {money(t1.balanceLimit)}</p>
          <p>No advances</p>
        </div>
        <div className="rounded-control border-2 border-success bg-success-soft p-3 text-success-strong">
          <p className="font-semibold">With {doc.name}</p>
          <p>{money(t2.dailyLimit)} a day</p>
          <p>Hold {money(t2.balanceLimit)}</p>
          <p>Advances after {m.advance.eligibleAfterWeeks} weeks</p>
        </div>
      </div>
      <Digits value={nin} length={doc.digits} group={[4, 8]} />
      <Keypad onKey={(k) => setNin((v) => applyKey(v, k, doc.digits, true))} />
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={nin.length !== doc.digits} onClick={async () => {
        const r = await onCheck(nin)
        if (r.ok === false) setNin('')
      }}>
        <Icon name="shield" /> Check my {doc.name}
      </BigButton>
      <button onClick={onSkip} disabled={busy} className="min-h-12 w-full rounded-control text-lg font-semibold text-accent-ink underline">
        <Y k="skip" /> <span className="block text-base font-normal text-secondary">You can add it later in Settings</span>
      </button>
    </Panel>
  )
}

function TrustedStep({ busy, msg, hint, onSave, onSkip }: { busy: boolean; msg: string | null; hint: string; onSave: (n: string, p: string) => void; onSkip: () => void }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  return (
    <Panel art={<ArtPeople />} k="trusted" why="If you lose your phone or forget your PIN, Plus can call this person to help you back in. They never see your money or move it.">
      <TextField label="Their name" value={name} onChange={setName} placeholder="Chidi" maxLength={40} />
      <TextField label="Their phone" value={phone} onChange={setPhone} inputMode="tel" placeholder={hint.replace(/\d{4}$/, '0199')} />
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={!name.trim() || phone.replace(/\D/g, '').length < 10} onClick={() => onSave(name, phone)}>
        <Icon name="userPlus" /> Save
      </BigButton>
      <button onClick={onSkip} disabled={busy} className="min-h-12 w-full rounded-control text-lg font-semibold text-accent-ink underline"><Y k="skip" /></button>
    </Panel>
  )
}

function WalletOpening({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  const secs = since ? Math.max(0, (now - since) / 1000) : null
  return (
    <div className="flex flex-col items-center gap-3 rounded-card bg-surface p-6 text-center shadow-card" role="status">
      <Spinner className="text-5xl text-accent-ink" />
      <p className="text-xl font-semibold">Opening your wallet on Stellar…</p>
      <p className="text-lg text-secondary">A few seconds. {secs !== null && <span className="font-mono">{secs.toFixed(1)} s</span>}</p>
    </div>
  )
}

function ReadyStep({ st, mode, busy, msg, onFinish }: { st: Status; mode: 'app' | 'agent'; busy: boolean; msg: string | null; onFinish: () => void }) {
  const w = st.wallet
  const acct = w.virtual_account ?? null
  return (
    <section className="space-y-5">
      <div className="space-y-3 text-center">
        <SuccessTick />
        <h2 className="text-3xl font-semibold"><Y k="ready" /></h2>
        <p className="text-lg text-secondary">{st.name} · {local(st.phone)}</p>
      </div>
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-lg font-semibold">Level {st.limits.tier}</p>
          <span className="rounded-full bg-success-soft px-3 py-1 text-base font-semibold text-success-strong">{st.limits.tier >= 2 ? 'ID checked' : 'Photo checked'}</span>
        </div>
        <p className="text-lg">Send up to <b>{st.limits.daily_text}</b> a day · hold up to <b>{st.limits.balance_text}</b></p>
        {st.limits.advances ? <p className="text-base text-secondary">Advances open after {getMarket(st.market).advance.eligibleAfterWeeks} weeks.</p> : <p className="text-base text-secondary">Add your {st.id_document?.name ?? 'ID'} later for higher limits and advances.</p>}
      </Card>
      {acct && (
        <Card className="space-y-2">
          <p className="text-lg font-semibold"><Icon name="bank" className="text-accent-ink" /> Your account number</p>
          <p className="font-mono text-3xl font-semibold tracking-wider">{acct.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')}</p>
          <p className="text-base text-secondary">{w.bank_label}. Anyone can send you money by bank transfer to this number.</p>
          <CopyButton text={acct} label="Copy number" />
        </Card>
      )}
      {w.account_url && (
        <a href={w.account_url} target="_blank" rel="noreferrer" className="flex min-h-14 items-center gap-2 rounded-control bg-success-soft px-4 text-lg font-semibold text-success-strong">
          <Icon name="link" /> See your wallet on Stellar Expert
        </a>
      )}
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton tone="leaf" className="w-full" loading={busy} onClick={onFinish}>
        {mode === 'agent' ? 'Finish' : <Y k="goToWallet" sub="text-white/85" />}
      </BigButton>
    </section>
  )
}

/** "I have an account": phone number and PIN (the PIN typed on the keypad). */
export function SignIn({ onBack }: { onBack: () => void }) {
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  async function go() {
    setBusy(true)
    setMsg(null)
    const market = phone.replace(/[\s()-]/g, '').startsWith('+91') ? 'in' : 'ng'
    const r = await tool('sign_in', { market, phone, pin }).catch(() => ({ text: 'No connection. Try again.', ok: false }) as ToolResult)
    setPin('')
    if (!r.ok || typeof r.sign_in_token !== 'string' || !supabase) {
      setBusy(false)
      return setMsg(r.text)
    }
    const { error } = await supabase.auth.verifyOtp({ token_hash: r.sign_in_token, type: 'magiclink' })
    setBusy(false)
    if (error) setMsg('Signing in did not work. Try again.')
  }
  return (
    <div className="mx-auto min-h-dvh max-w-md space-y-5 px-4 pb-16 pt-4">
      <header className="flex items-center gap-3">
        <button onClick={onBack} aria-label="Back" className="grid size-12 shrink-0 place-items-center rounded-full bg-fill text-2xl active:bg-fill-strong"><Icon name="back" /></button>
        <h1 className="text-3xl font-semibold"><Y k="signIn" /></h1>
      </header>
      <TextField label="Your phone number" value={phone} onChange={setPhone} inputMode="tel" placeholder="0700 000 0201" autoComplete="tel" />
      <div>
        <p className="text-xl font-semibold"><Icon name="lock" /> Your PIN</p>
        <PinDots length={pin.length} />
        <Keypad onKey={(k) => setPin((p) => applyKey(p, k, 6, true))} />
      </div>
      {msg && <Notice tone="chili">{msg}</Notice>}
      <BigButton className="w-full" loading={busy} disabled={pin.length < 4 || phone.replace(/\D/g, '').length < 10} onClick={() => void go()}>
        <Y k="signIn" sub="text-on-accent/80" />
      </BigButton>
      <p className="text-center text-base text-secondary">Too many wrong PINs locks sign-in for 15 minutes.</p>
    </div>
  )
}
