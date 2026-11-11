// /demo: the staff view for the projector. Staff login (app_metadata.role = staff).
//   Top: Nigeria / India switch.
//   Left: the Plus app in a phone frame, signed in as Funmi (or Selvi): /app?as=funmi in an iframe
//         with its own login, so both phones stay signed in and the switch is instant.
//   Right: a live feed of the Stellar transactions behind what the phone does (Funmi, Mama Bisi, the
//         ajo pot, the advance pool; Selvi's record in India), each with the seconds from her Yes to
//         confirmed on-chain and a Stellar Expert link. Read through the staff-only demo_feed().
// Always dark and cinematic (whatever the projector laptop's setting): the dark tokens are set on
// the page's root element, so every design-system component below reads them.
import { formatTime } from '../lib/time'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { formatMoney } from '@plus/markets'
import { Button, Icon, Notice, Segmented, Spinner, spring } from '../ds/components'
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

/** The dark tokens, forced for this page only (same values as tokens.css dark mode). */
const DARK = {
  colorScheme: 'dark',
  '--canvas': '#000000',
  '--surface': '#161618',
  '--surface-2': '#1d1d20',
  '--fill': '#26262a',
  '--fill-strong': '#333338',
  '--hairline': '#2a2a2e',
  '--label': '#f4f4f6',
  '--secondary': '#a3a4ad',
  '--glass': 'rgb(22 22 24 / 0.72)',
  '--scrim': 'rgb(0 0 0 / 0.55)',
  '--success': '#4cc38a',
  '--success-soft': '#11291d',
  '--warning': '#f0b45a',
  '--warning-soft': '#2b2112',
  '--danger': '#f2877d',
  '--danger-soft': '#2e1614',
  '--info': '#8db6f2',
  '--info-soft': '#14213a',
  '--shadow-card': '0 0 0 1px rgb(255 255 255 / 0.05)',
  '--shadow-lift': '0 0 0 1px rgb(255 255 255 / 0.06), 0 24px 48px -20px rgb(0 0 0 / 0.8)',
  '--accent': '#16815a',
  '--accent-strong': '#1a9467',
  '--accent-ink': '#5cc99a',
  '--accent-soft': '#10271d',
} as CSSProperties

const STAGE_BG = 'radial-gradient(1200px 700px at 18% 10%, rgb(22 129 90 / 0.18), transparent 60%), radial-gradient(900px 600px at 90% 100%, rgb(79 71 214 / 0.14), transparent 60%), linear-gradient(180deg, #050506 0%, #000 100%)'

function Dark({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div style={{ ...DARK, background: STAGE_BG }} className={`min-h-dvh text-label ${className}`}>
      {children}
    </div>
  )
}

export default function DemoPage() {
  const { session, ready } = useSession()
  if (!ready) return <Dark>{null}</Dark>
  if (!session) return <StaffLogin />
  if (session.user.app_metadata?.role !== 'staff') return <NotStaff session={session} />
  return <Stage />
}

// ---------------------------------------------------------------------------

const field = 'mt-1.5 block min-h-14 w-full rounded-control border border-hairline bg-surface-2 px-4 text-lg text-label focus:border-accent focus:outline-none'

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
    <Dark className="flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-md space-y-5 rounded-sheet border border-hairline bg-surface/80 p-8 shadow-lift backdrop-blur-xl">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-secondary">Staff</p>
          <h1 className="text-3xl font-semibold">Plus · demo view</h1>
          <p className="mt-1 text-base text-secondary">Staff login (created with <code className="font-mono">pnpm staff:create</code>).</p>
        </div>
        <label className="block">
          <span className="text-base font-medium text-secondary">Email</span>
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
        </label>
        <label className="block">
          <span className="text-base font-medium text-secondary">Password</span>
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" className="w-full" loading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </Dark>
  )
}

function NotStaff({ session }: { session: Session }) {
  return (
    <Dark className="flex flex-col items-center justify-center gap-5 p-6 text-center">
      <p className="text-2xl font-medium">{session.user.email} is not a staff login.</p>
      <Button variant="secondary" onClick={() => void supabase?.auth.signOut()}>Sign out</Button>
    </Dark>
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
  // The accent follows the country on stage.
  const accent = market === 'in'
    ? ({ '--accent': '#4f47d6', '--accent-strong': '#6159e4', '--accent-ink': '#a9a4fb', '--accent-soft': '#1b1940' } as CSSProperties)
    : {}
  return (
    <div style={{ ...DARK, ...accent, background: STAGE_BG }} className="flex h-dvh flex-col text-label">
      <header className="flex flex-wrap items-center justify-between gap-6 border-b border-white/5 px-8 py-5">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">
            Plus <span className="font-light text-secondary">· live on Stellar</span>
          </h1>
          <AnimatePresence mode="wait">
            <motion.p key={market} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1 text-lg text-secondary">
              {PEOPLE[market].name}: {PEOPLE[market].story}
            </motion.p>
          </AnimatePresence>
        </div>
        <div className="w-72">
          <Segmented label="Country" value={market} onChange={choose} options={[['ng', PEOPLE.ng.flag], ['in', PEOPLE.in.flag]]} />
        </div>
        <Button variant="plain" size="sm" onClick={() => void supabase?.auth.signOut()}>Sign out</Button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-10 p-8 lg:grid-cols-[auto_1fr]">
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

const FRAME_W = 390 + 2 * 14
const FRAME_H = 844 + 2 * 14

/** A 390 × 844 phone in a realistic frame (bezel, edge highlight, island), scaled to the height available. */
function Phone({ src, title, hidden }: { src: string; title: string; hidden: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(Math.min(1.2, Math.max(0.4, (el.clientHeight - 16) / FRAME_H)))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    // display:none keeps the iframe loaded (and signed in), so switching country is instant.
    <div ref={box} className={`h-full items-center justify-center ${hidden ? 'hidden' : 'flex'}`} aria-hidden={hidden}>
      <div style={{ width: FRAME_W * scale, height: FRAME_H * scale }}>
        <div
          className="relative origin-top-left rounded-[3.5rem] p-[14px]"
          style={{
            width: FRAME_W,
            height: FRAME_H,
            transform: `scale(${scale})`,
            background: 'linear-gradient(145deg, #3a3a3e 0%, #1a1a1c 35%, #0c0c0d 65%, #2a2a2d 100%)',
            boxShadow: '0 0 0 1px rgb(255 255 255 / 0.08), inset 0 0 0 1.5px rgb(255 255 255 / 0.12), inset 0 0 0 6px #050505, 0 60px 120px -30px rgb(0 0 0 / 0.9), 0 30px 60px -20px rgb(22 129 90 / 0.15)',
          }}
        >
          <div className="relative size-full overflow-hidden rounded-[2.75rem] bg-black">
            <iframe src={src} title={title} allow="microphone" className="block size-full border-0 bg-canvas" style={{ width: 390, height: 844 }} />
            <span aria-hidden className="pointer-events-none absolute left-1/2 top-[11px] h-[30px] w-[118px] -translate-x-1/2 rounded-full bg-black" />
          </div>
          {/* side buttons */}
          <span aria-hidden className="absolute -left-[3px] top-[150px] h-8 w-[3px] rounded-l bg-[#2a2a2d]" />
          <span aria-hidden className="absolute -left-[3px] top-[205px] h-14 w-[3px] rounded-l bg-[#2a2a2d]" />
          <span aria-hidden className="absolute -left-[3px] top-[272px] h-14 w-[3px] rounded-l bg-[#2a2a2d]" />
          <span aria-hidden className="absolute -right-[3px] top-[230px] h-20 w-[3px] rounded-r bg-[#2a2a2d]" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

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
    <section aria-label="Stellar transactions" className="flex min-h-0 flex-col overflow-hidden rounded-sheet border border-white/[0.06] bg-surface/70 shadow-lift backdrop-blur-xl">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-hairline px-7 py-5">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-secondary">Stellar testnet</p>
          <h2 className="text-2xl font-semibold">On Stellar, as it happens</h2>
        </div>
        {median && (
          <p className="text-right">
            <span className="block text-sm text-secondary">Yes → confirmed, median of {median.n}</span>
            <span className="num font-mono text-3xl font-light text-success">{median.value.toFixed(1)} s</span>
          </p>
        )}
      </div>
      {error && <div className="m-5"><Notice tone="danger">{error}</Notice></div>}
      <div className="grid grid-cols-[6.5rem_7rem_1fr_6rem_6.5rem] gap-4 border-b border-hairline px-7 py-2 font-mono text-xs uppercase tracking-wider text-secondary">
        <span>Time</span><span>Account</span><span>What happened</span><span className="text-right">Yes → ✓</span><span className="text-right">Tx</span>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto font-mono" aria-live="polite">
        {rows === null && <li className="flex items-center gap-2 px-7 py-6 text-lg text-secondary"><Spinner /> Loading…</li>}
        {rows?.length === 0 && <li className="px-7 py-6 text-lg text-secondary">Nothing yet. Tap something on the phone.</li>}
        <AnimatePresence initial={false}>
          {rows?.map((r) => {
            const amount = r.amount_minor !== null ? formatMoney(BigInt(Math.abs(Number(r.amount_minor))), market) : null
            const done = r.status === 'done'
            return (
              <motion.li
                key={r.id}
                layout
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={spring}
                className={`grid grid-cols-[6.5rem_7rem_1fr_6rem_6.5rem] items-baseline gap-4 border-b border-white/[0.04] px-7 py-3.5 text-base transition-colors duration-1000 ${fresh.has(r.id) ? 'bg-accent-soft' : ''}`}
              >
                <span className="num text-secondary">{formatTime(r.created_at, { seconds: true })}</span>
                <span className="truncate text-accent-ink">{r.account}</span>
                <span className="min-w-0 font-sans text-lg">
                  {describe(r, market)}
                  {amount && <span className="num font-mono text-secondary"> · {amount}</span>}
                </span>
                <span className="num text-right">
                  {done ? (
                    <span className="text-success">{r.automatic ? 'auto' : `${Number(r.seconds).toFixed(1)} s`}</span>
                  ) : r.status === 'failed' ? (
                    <span className="text-danger">retrying</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-warning"><Spinner /> sending</span>
                  )}
                </span>
                <span className="text-right">
                  {r.tx_hash ? (
                    <a href={`${EXPERT}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 text-secondary hover:text-label" aria-label={`Open transaction ${r.tx_hash.slice(0, 8)} on Stellar Expert`}>
                      {r.tx_hash.slice(0, 6)}… <Icon name="link" className="text-sm" />
                    </a>
                  ) : (
                    <span className="text-secondary">—</span>
                  )}
                </span>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ol>
    </section>
  )
}
