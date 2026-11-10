// /demo: the staff view for the projector. Staff login (app_metadata.role = staff).
//   Top: Nigeria / India switch.
//   Left: the Plus app in a phone frame, signed in as Funmi (or Selvi): /app?as=funmi in an iframe
//         with its own login, so both phones stay signed in and the switch is instant.
//   Right: a live feed of the Stellar transactions behind what the phone does (Funmi, Mama Bisi, the
//         ajo pot, the advance pool; Selvi's record in India), each with the seconds from her Yes to
//         confirmed on-chain and a Stellar Expert link. Read through the staff-only demo_feed().
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { formatMoney } from '@plus/markets'
import { supabase } from '../lib/supabase'
import { useSession } from '../plus/auth'

const EXPERT = 'https://stellar.expert/explorer/testnet'
type Market = 'ng' | 'in'

type FeedRow = {
  id: number
  created_at: string
  done_at: string | null
  seconds: number | string | null
  status: 'queued' | 'submitted' | 'done' | 'failed'
  account: string
  kind: string
  fn: string | null
  tx_kind: string | null
  tx_source: string | null
  person: string | null
  amount_minor: number | null
  currency: string
  tx_hash: string | null
  automatic: boolean
}

export default function DemoPage() {
  const { session, ready } = useSession()
  if (!ready) return null
  if (!session) return <StaffLogin />
  if (session.user.app_metadata?.role !== 'staff') return <NotStaff session={session} />
  return <Stage />
}

// ---------------------------------------------------------------------------

function StaffLogin() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return setError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the repo-root .env.local.')
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(error.message)
  }
  return (
    <main className="flex min-h-dvh items-center justify-center bg-cream p-6 text-ink">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-3xl bg-white p-8 shadow-[0_3px_0_0_var(--color-sand-deep)]">
        <h1 className="text-4xl font-extrabold text-brick">Plus · demo view</h1>
        <p className="text-lg text-ink-soft">Staff login (created with <code>pnpm staff:create</code>).</p>
        <label className="block">
          <span className="text-lg font-bold">Email</span>
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block min-h-14 w-full rounded-2xl border-2 border-sand-deep px-4 text-xl" />
        </label>
        <label className="block">
          <span className="text-lg font-bold">Password</span>
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block min-h-14 w-full rounded-2xl border-2 border-sand-deep px-4 text-xl" />
        </label>
        {error && <p className="rounded-2xl bg-chili-soft p-3 text-lg font-semibold text-chili">{error}</p>}
        <button disabled={busy} className="min-h-16 w-full rounded-2xl bg-brick text-2xl font-extrabold text-cream disabled:opacity-60">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}

function NotStaff({ session }: { session: Session }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-ink">
      <p className="text-2xl font-bold">{session.user.email} is not a staff login.</p>
      <button onClick={() => void supabase?.auth.signOut()} className="min-h-14 rounded-2xl bg-brick px-6 text-xl font-bold text-cream">Sign out</button>
    </main>
  )
}

// ---------------------------------------------------------------------------

const PEOPLE: Record<Market, { name: string; story: string; flag: string }> = {
  ng: { name: 'Funmi', story: 'Tomato seller, Ibadan · no bank account · her wallet is on Stellar', flag: 'Nigeria' },
  in: { name: 'Selvi', story: 'Flower seller, Madurai · bank account · her record is on Stellar', flag: 'India' },
}

function Stage() {
  const [market, setMarket] = useState<Market>('ng')
  const [mounted, setMounted] = useState<Set<Market>>(() => new Set(['ng']))
  const choose = (m: Market) => {
    setMarket(m)
    setMounted((s) => new Set(s).add(m))
  }
  return (
    <div className="flex h-dvh flex-col bg-cream text-ink">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b-4 border-sand-deep bg-white px-8 py-4">
        <div>
          <h1 className="text-4xl font-extrabold text-brick">Plus <span className="font-bold text-ink">· live on Stellar</span></h1>
          <p className="text-xl text-ink-soft">{PEOPLE[market].name}: {PEOPLE[market].story}</p>
        </div>
        <div role="radiogroup" aria-label="Country" className="inline-flex rounded-full bg-sand p-1.5">
          {(['ng', 'in'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={market === m} onClick={() => choose(m)}
              className={`min-h-14 rounded-full px-8 text-2xl font-extrabold ${market === m ? 'bg-brick text-cream shadow' : 'text-ink-soft'}`}>
              {PEOPLE[m].flag}
            </button>
          ))}
        </div>
        <button onClick={() => void supabase?.auth.signOut()} className="text-lg font-semibold text-ink-soft underline">Sign out</button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 p-6 lg:grid-cols-[auto_1fr]">
        <section aria-label={`${PEOPLE[market].name}'s phone`} className="flex h-[80vh] min-h-0 justify-center lg:h-auto">
          {(['ng', 'in'] as const).map((m) => mounted.has(m) && (
            <Phone key={m} src={`/app?as=${m === 'ng' ? 'funmi' : 'selvi'}`} title={`${PEOPLE[m].name}'s Plus app`} hidden={m !== market} />
          ))}
        </section>
        <Feed key={market} market={market} />
      </main>
    </div>
  )
}

/** A 390 × 844 phone, scaled to the height available. */
function Phone({ src, title, hidden }: { src: string; title: string; hidden: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(Math.min(1.25, Math.max(0.4, (el.clientHeight - 8) / 868)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    // display:none keeps the iframe loaded (and signed in), so switching country is instant.
    <div ref={box} className={`h-full justify-center ${hidden ? 'hidden' : 'flex'}`} aria-hidden={hidden}>
      <div style={{ width: 414 * scale, height: 868 * scale }}>
        <div className="origin-top-left rounded-[3.25rem] border-[12px] border-ink bg-ink shadow-2xl" style={{ width: 414, height: 868, transform: `scale(${scale})` }}>
          <iframe src={src} title={title} allow="microphone" className="size-full rounded-[2.5rem] bg-cream" style={{ width: 390, height: 844 }} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

const ACCOUNT_STYLE: Record<string, string> = {
  Funmi: 'bg-brick text-cream',
  'Mama Bisi': 'bg-saffron text-ink',
  'Ajo pot': 'bg-leaf text-white',
  'Advance pool': 'bg-ink text-cream',
  'Seettu record': 'bg-leaf text-white',
  'Advance record': 'bg-ink text-cream',
}

const ATTEST_WORDS: Record<string, string> = { pay: 'payment', incoming: 'money in', saved: 'saved', group_contribution: 'seettu', cash_out: 'cash out' }

function describe(r: FeedRow, market: Market): string {
  const who = r.person ?? PEOPLE[market].name
  if (r.kind === 'payment') {
    if (r.tx_kind === 'incoming' && r.tx_source === 'cash') return `Mama Bisi → ${who}: cash-in`
    if (r.tx_kind === 'incoming' && r.tx_source === 'ajo_payout') return `Ajo payout → ${who}`
    if (r.tx_kind === 'pay') return `${who} pays her supplier`
    return `Payment for ${who}`
  }
  if (r.kind === 'claimable_create') return `${who} cashes out: held on Stellar for an agent`
  if (r.kind === 'claimable_claim') return r.account === 'Mama Bisi' ? `Mama Bisi redeems ${who}'s cash-out code` : `Unused cash-out goes back to ${who}`
  if (r.fn === 'group_contribute') return `${who} pays into the ajo pot`
  if (r.fn === 'group_payout') return r.person ? `Ajo pot pays ${r.person}` : 'Ajo pot pays this round'
  if (r.fn === 'request_advance') return `Advance pool → ${who}`
  if (r.fn === 'repay') return `${who} repays the advance pool`
  if (r.kind === 'attest') return `${who}'s record: ${ATTEST_WORDS[r.tx_kind ?? ''] ?? 'entry'}`
  if (r.kind === 'group_record') return `${who}'s seettu payment recorded`
  if (r.kind === 'record_advance') return `${who}'s advance recorded`
  if (r.kind === 'record_repayment') return `${who}'s repayment recorded`
  return r.kind
}

function Feed({ market }: { market: Market }) {
  const [rows, setRows] = useState<FeedRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seen = useRef<Set<number> | null>(null)
  const [fresh, setFresh] = useState<Set<number>>(() => new Set())

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.rpc('demo_feed', { p_market: market, p_limit: 20 })
    if (error) return setError(error.message)
    setError(null)
    const list = (data ?? []) as FeedRow[]
    if (seen.current) {
      const added = list.filter((r) => !seen.current!.has(r.id)).map((r) => r.id)
      if (added.length) {
        setFresh(new Set(added))
        window.setTimeout(() => setFresh(new Set()), 6000)
      }
    }
    seen.current = new Set(list.map((r) => r.id))
    setRows(list)
  }, [market])

  useEffect(() => {
    void load()
    const id = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(id)
  }, [load])

  const median = useMemo(() => {
    const s = (rows ?? []).filter((r) => r.status === 'done' && !r.automatic && r.seconds !== null).map((r) => Number(r.seconds)).sort((a, b) => a - b)
    return s.length ? { value: s[Math.floor((s.length - 1) / 2)], n: s.length } : null
  }, [rows])

  return (
    <section aria-label="Stellar transactions" className="flex min-h-0 flex-col rounded-[2rem] bg-white shadow-[0_3px_0_0_var(--color-sand-deep)]">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b-2 border-sand px-6 py-4">
        <h2 className="text-3xl font-extrabold">On Stellar, as it happens</h2>
        {median && <p className="text-2xl text-ink-soft">Yes → confirmed: <b className="text-leaf">{median.value.toFixed(1)} s</b> median of {median.n}</p>}
      </div>
      {error && <p className="m-4 rounded-2xl bg-chili-soft p-4 text-xl text-chili">{error}</p>}
      <ol className="min-h-0 flex-1 divide-y-2 divide-sand overflow-y-auto" aria-live="polite">
        {rows === null && <li className="p-6 text-2xl text-ink-soft">Loading…</li>}
        {rows?.length === 0 && <li className="p-6 text-2xl text-ink-soft">Nothing yet. Tap something on the phone.</li>}
        {rows?.map((r) => {
          const amount = r.amount_minor !== null ? formatMoney(BigInt(Math.abs(Number(r.amount_minor))), market) : null
          const done = r.status === 'done'
          return (
            <li key={r.id} className={`grid grid-cols-[auto_1fr_auto] items-center gap-x-5 gap-y-1 px-6 py-4 transition-colors ${fresh.has(r.id) ? 'bg-turmeric/25' : ''}`}>
              <span className={`row-span-2 rounded-2xl px-4 py-2 text-xl font-extrabold ${ACCOUNT_STYLE[r.account] ?? 'bg-sand text-ink'}`}>{r.account}</span>
              <p className="text-2xl font-bold">{describe(r, market)}{amount && <span className="text-brick"> · {amount}</span>}</p>
              <p className="row-span-2 text-right text-2xl font-extrabold">
                {done ? (
                  <span className="text-leaf">✓ {r.automatic ? 'automatic' : `${Number(r.seconds).toFixed(1)} s`}</span>
                ) : r.status === 'failed' ? (
                  <span className="text-chili">retrying</span>
                ) : (
                  <span className="animate-pulse text-saffron">⏳ sending</span>
                )}
              </p>
              <p className="text-lg text-ink-soft">
                {new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                {done && !r.automatic && ' · from her Yes to confirmed on-chain'}
                {r.tx_hash && (
                  <>
                    {' · '}
                    <a href={`${EXPERT}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer" className="font-bold text-brick underline">
                      Stellar Expert {r.tx_hash.slice(0, 8)}↗
                    </a>
                  </>
                )}
              </p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
