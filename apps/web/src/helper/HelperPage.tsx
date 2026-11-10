// The helper page (/helper): Meena records cash a member handed her. Nothing moves until the
// member says Yes in her own Plus app; the daily limit is enforced by the database.
import { useCallback, useEffect, useState } from 'react'
import { DEMO_MEENA_EMAIL, supabase } from '../lib/supabase'
import { call, newKey } from '../plus/api'
import { DemoLogin, useSession } from '../plus/auth'
import type { Key, Lang } from '../plus/i18n'
import { applyKey, BigButton, Card, Icon, Keypad, L, LangContext, Notice } from '../plus/ui'
import { whenText } from '../plus/data'

type Me = {
  helper: { id: string; name: string }
  limit_text: string
  used_today_text: string
  left_today_text: string
  people: { user_id: string; name: string }[]
  recent: { id: string; name: string; amount_text: string; status: string; at: string }[]
  ok?: boolean
  error?: string
  text?: string
}

const STATUS: Record<string, [Key, string]> = {
  awaiting_user: ['statusAwaiting', 'bg-fill text-label'],
  confirmed: ['statusConfirmed', 'bg-success-soft text-success'],
  rejected: ['statusRejected', 'bg-danger-soft text-danger'],
  expired: ['statusExpired', 'bg-fill text-secondary'],
}

export default function HelperPage() {
  const [lang, setLang] = useState<Lang>('ta')
  const { session, ready } = useSession()
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <div className="min-h-dvh bg-canvas text-label">
        {!ready ? null : session ? <Signed /> : <DemoLogin email={DEMO_MEENA_EMAIL} label="continueAsMeena" />}
      </div>
    </LangContext.Provider>
  )
}

function Signed() {
  const [me, setMe] = useState<Me | null>(null)
  const [who, setWho] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [key, setKey] = useState(() => newKey('helper'))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'leaf' | 'chili'; text: string } | null>(null)

  const load = useCallback(async () => {
    setMe(await call<Me>('helper-api/me'))
  }, [])
  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 10_000)
    return () => window.clearInterval(id)
  }, [load])

  async function record() {
    if (!who || !amount) return
    setBusy(true)
    setMsg(null)
    // One idempotency key per entry, so a double tap or a retry records it once.
    const r = await call<Me>('helper-api/record_cash_in', { user_id: who, amount: Number(amount), idempotency_key: key }).catch(
      () => ({ error: 'network', text: 'No connection. Try again.' }) as Me,
    )
    setBusy(false)
    if (r.ok) {
      setMsg({ tone: 'leaf', text: r.text ?? '' })
      setMe(r)
      setAmount('')
      setWho(null)
      setKey(newKey('helper'))
    } else setMsg({ tone: 'chili', text: r.text ?? r.error ?? 'Error' })
  }

  if (!me) return <p className="py-20 text-center text-2xl">…</p>
  if (me.error) {
    return (
      <div className="mx-auto max-w-md p-6">
        <Notice tone="chili">{me.error === 'not_a_helper' ? 'This login is not a helper.' : me.text ?? me.error}</Notice>
        <BigButton tone="white" className="mt-4 w-full" onClick={() => void supabase?.auth.signOut()}>
          <L k="signOut" />
        </BigButton>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-5 px-4 pb-16 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-base font-semibold uppercase tracking-wide text-warning">
            <L k="helperTitle" />
          </p>
          <h1 className="text-3xl font-semibold">{me.helper.name}</h1>
        </div>
        <button onClick={() => void supabase?.auth.signOut()} className="min-h-11 rounded-full border-2 border-fill-strong bg-surface px-4 text-base font-semibold">
          <L k="signOut" />
        </button>
      </header>

      <Card className="bg-accent! text-on-accent">
        <L k="leftToday" sub="text-on-accent/80" className="text-lg font-semibold" />
        <p className="mt-1 text-4xl font-semibold text-warning">{me.left_today_text}</p>
        <p className="mt-1 text-base text-on-accent/80">
          {me.used_today_text} / {me.limit_text}
        </p>
      </Card>

      <Card>
        <h2 className="text-2xl font-semibold">
          <L k="recordCash" />
        </h2>
        <p className="mt-4 text-xl font-semibold">
          <L k="whoGaveCash" />
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {me.people.map((p) => (
            <button
              key={p.user_id}
              onClick={() => setWho(p.user_id)}
              className={`flex min-h-16 items-center gap-2 rounded-2xl px-4 text-xl font-semibold ${who === p.user_id ? 'bg-accent text-on-accent' : 'bg-fill text-label'}`}
            >
              <Icon name="person" /> {p.name}
            </button>
          ))}
        </div>
        {who && (
          <>
            <p className="my-4 text-center text-5xl font-semibold text-accent-ink" aria-live="polite">
              ₹{amount ? Number(amount).toLocaleString('en-IN') : '0'}
            </p>
            <Keypad onKey={(k) => setAmount((a) => applyKey(a, k, 6))} />
            <BigButton className="mt-4 w-full" onClick={record} disabled={!amount || busy}>
              <Icon name="hand" /> <L k="recordCash" sub="text-on-accent/80" />
            </BigButton>
          </>
        )}
        {msg && (
          <div className="mt-3">
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
      </Card>

      <h2 className="text-2xl font-semibold">
        <L k="recent" />
      </h2>
      <ul className="space-y-2">
        {me.recent.map((r) => {
          const [k, cls] = STATUS[r.status] ?? ['statusAwaiting', 'bg-fill']
          return (
            <li key={r.id} className="flex items-center justify-between gap-3 rounded-2xl bg-surface p-4 shadow-[0_2px_0_0_var(--color-sand-deep)]">
              <div>
                <p className="text-xl font-semibold">
                  {r.name} · {r.amount_text}
                </p>
                <p className="text-base text-secondary">{whenText(r.at, 'ta')}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-base font-semibold ${cls}`}>
                <L k={k} sub="hidden" />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
