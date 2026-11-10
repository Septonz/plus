// The agent page (/agent): Mama Bisi, a Plus cash agent at Bodija market. Mobile first.
//   Record cash from a customer: phone + amount. Nothing moves until the customer says Yes in
//   her Plus app; then NGNT goes from Mama Bisi's float to her wallet on Stellar.
//   Redeem a cash-out code: phone + 6-digit code -> "give her ₦X" -> Done -> Mama Bisi claims the
//   cash-out on Stellar.
import { useCallback, useEffect, useState } from 'react'
import { DEMO_MAMA_BISI_EMAIL, supabase } from '../lib/supabase'
import { call, newKey } from '../plus/api'
import { DemoChoice, useSession } from '../plus/auth'
import { applyKey, BigButton, Card, Icon, Keypad, Notice } from '../plus/ui'
import { naira, when } from '../ng/words'

type Item = { id: string; name: string; amount_text: string; status: string; at: string; url: string | null }
type Me = {
  agent: { id: string; name: string }
  float_text: string
  float_free_text: string
  wallet_url: string | null
  limit_text: string
  used_today_text: string
  left_today_text: string
  recent: Item[]
  redeemed: Item[]
  ok?: boolean
  error?: string
  text?: string
}
type Answer = Partial<Me> & { ok?: boolean; error?: string; text?: string; amount_text?: string; attempts_left?: number }

const STATUS: Record<string, [string, string]> = {
  awaiting_user: ['Waiting for her Yes', 'bg-sand text-ink'],
  confirmed: ['Sending…', 'bg-sand text-ink'],
  on_stellar: ['✓ On Stellar', 'bg-leaf-soft text-leaf'],
  sending: ['Sending…', 'bg-sand text-ink'],
  rejected: ['She said No', 'bg-chili-soft text-chili'],
  expired: ['Expired', 'bg-sand text-ink-soft'],
}

export default function AgentPage() {
  const { session, ready } = useSession()
  return (
    <div className="min-h-dvh bg-cream text-ink">
      {!ready ? null : session ? <Signed /> : (
        <DemoChoice people={[{ email: DEMO_MAMA_BISI_EMAIL, label: 'Continue as Mama Bisi', note: 'Plus cash agent · Bodija market, Ibadan' }]} />
      )}
    </div>
  )
}

function Phone({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xl font-bold">Customer's phone</span>
      <input
        inputMode="tel"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0803 123 4567"
        className="mt-2 block min-h-16 w-full rounded-2xl border-2 border-sand-deep bg-white px-4 text-2xl font-bold"
      />
    </label>
  )
}

function Signed() {
  const [me, setMe] = useState<Me | null>(null)
  const [tab, setTab] = useState<'cash' | 'code'>('cash')
  const [phone, setPhone] = useState('+2340000000501') // Funmi (demo number)
  const [amount, setAmount] = useState('')
  const [code, setCode] = useState('')
  const [checked, setChecked] = useState<string | null>(null)
  const [key, setKey] = useState(() => newKey('agent'))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'leaf' | 'chili' | 'sand'; text: string } | null>(null)

  const load = useCallback(async () => setMe(await call<Me>('agent-api/me')), [])
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 5_000)
    return () => window.clearInterval(id)
  }, [load])

  async function send(path: string, body: Record<string, unknown>): Promise<Answer> {
    setBusy(true)
    setMsg(null)
    const r = await call<Answer>(`agent-api/${path}`, body).catch(() => ({ error: 'network', text: 'No connection. Try again.' }) as Answer)
    setBusy(false)
    if (r.agent) setMe(r as Me)
    return r
  }

  async function record() {
    // One idempotency key per entry: a double tap or a retry records it once.
    const r = await send('record_cash_in', { phone, amount, idempotency_key: key })
    if (r.ok) {
      setMsg({ tone: 'leaf', text: r.text ?? '' })
      setAmount('')
      setKey(newKey('agent'))
    } else setMsg({ tone: 'chili', text: r.text ?? r.error ?? 'Error' })
  }

  async function check() {
    const r = await send('check_code', { phone, code })
    if (r.ok) {
      setChecked(r.amount_text ?? null)
      setMsg({ tone: 'sand', text: r.text ?? '' })
    } else {
      setChecked(null)
      setMsg({ tone: 'chili', text: `${r.text ?? r.error}${typeof r.attempts_left === 'number' ? ` ${r.attempts_left} tries left.` : ''}` })
    }
  }

  async function redeem() {
    const r = await send('redeem_code', { phone, code })
    setChecked(null)
    if (r.ok) {
      setCode('')
      setMsg({ tone: 'leaf', text: r.text ?? '' })
    } else setMsg({ tone: 'chili', text: r.text ?? r.error ?? 'Error' })
  }

  if (!me) return <p className="py-20 text-center text-2xl">…</p>
  if (me.error) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Notice tone="chili">{me.error === 'not_an_agent' ? 'This login is not a Plus cash agent.' : me.text ?? me.error}</Notice>
        <BigButton tone="white" className="mt-4 w-full" onClick={() => void supabase?.auth.signOut()}>Sign out</BigButton>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-5 px-4 pb-16 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-base font-bold uppercase tracking-wide text-saffron">Plus cash agent</p>
          <h1 className="text-3xl font-extrabold">{me.agent.name}</h1>
        </div>
        <button onClick={() => void supabase?.auth.signOut()} className="min-h-11 rounded-full border-2 border-sand-deep bg-white px-4 text-base font-bold">Sign out</button>
      </header>

      <Card className="bg-brick! text-cream">
        <p className="text-lg font-semibold">Float on Stellar</p>
        <p className="mt-1 text-4xl font-extrabold text-turmeric">{me.float_text}</p>
        <p className="mt-1 text-base text-cream/80">
          {me.float_free_text} free · {me.left_today_text} left today (limit {me.limit_text})
        </p>
        {me.wallet_url && <a href={me.wallet_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-base font-bold text-cream underline">See float on Stellar Expert</a>}
      </Card>

      <div className="grid grid-cols-2 gap-3" role="tablist">
        {([['cash', 'add', 'Record cash'], ['code', 'hand', 'Redeem code']] as const).map(([t, icon, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setMsg(null) }}
            className={`flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl text-xl font-extrabold ${tab === t ? 'bg-brick text-cream' : 'bg-white shadow-[0_2px_0_0_var(--color-sand-deep)]'}`}>
            <Icon name={icon} className="text-3xl" /> {label}
          </button>
        ))}
      </div>

      <Card>
        <Phone value={phone} onChange={setPhone} />
        {tab === 'cash' ? (
          <>
            <p className="mt-4 text-xl font-bold">Cash she gave you</p>
            <p className="my-3 text-center text-5xl font-extrabold text-brick" aria-live="polite">{naira(BigInt(amount || '0') * 100n)}</p>
            <Keypad onKey={(k) => setAmount((a) => applyKey(a, k, 7))} />
            <BigButton className="mt-4 w-full" onClick={record} disabled={!amount || !phone || busy}>
              <Icon name="hand" /> Record cash
            </BigButton>
            <p className="mt-2 text-base text-ink-soft">Nothing moves until she says Yes in her Plus app.</p>
          </>
        ) : (
          <>
            <p className="mt-4 text-xl font-bold">Her 6-digit code</p>
            <p className="my-3 text-center font-mono text-5xl font-extrabold tracking-[0.2em]" aria-live="polite">{code.padEnd(6, '·')}</p>
            <Keypad onKey={(k) => { setCode((c) => applyKey(c, k, 6, true)); setChecked(null) }} />
            {checked ? (
              <BigButton tone="leaf" className="mt-4 w-full" onClick={redeem} disabled={busy}>
                <Icon name="check" /> I gave her {checked}. Done
              </BigButton>
            ) : (
              <BigButton className="mt-4 w-full" onClick={check} disabled={code.length !== 6 || !phone || busy}>Check code</BigButton>
            )}
          </>
        )}
        {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      </Card>

      <h2 className="text-2xl font-extrabold">{tab === 'cash' ? 'Recent cash-ins' : 'Codes you redeemed'}</h2>
      <ul className="space-y-2">
        {(tab === 'cash' ? me.recent : me.redeemed).map((r) => {
          const [label, cls] = STATUS[r.status] ?? [r.status, 'bg-sand']
          const badge = <span className={`rounded-full px-3 py-1 text-base font-bold ${cls}`}>{label}</span>
          return (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-[0_2px_0_0_var(--color-sand-deep)]">
              <div>
                <p className="text-xl font-bold">{r.name} · {r.amount_text}</p>
                <p className="text-base text-ink-soft">{when(r.at)}</p>
              </div>
              {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{badge}</a> : badge}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
