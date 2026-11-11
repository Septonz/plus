// The agent page (/agent): Mama Bisi, a Plus cash agent at Bodija market. Mobile first.
//   Record cash from a customer: phone + amount. Nothing moves until the customer says Yes in
//   her Plus app; then NGNT goes from Mama Bisi's float to her wallet on Stellar.
//   Redeem a cash-out code: phone + 6-digit code -> "give her ₦X" -> Done -> Mama Bisi claims the
//   cash-out on Stellar. Codes sent to someone not on Plus (pay by phone) work the same way.
//   Register a customer: the same sign-up as the app, run on Mama Bisi's screen with the customer
//   answering (she types her own PIN and NIN). A kiosk would be this screen on a shared tablet.
//   Asset checks: customers who asked her to confirm an asset, and inspections in her market.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  AmountDisplay, Button, Card, EmptyState, Icon, ListGroup, ListRow, Notice, NumPad, PageHeader, Section, Segmented, Spinner,
  VerifiedMark, applyKey, useMarketAccent,
} from '../ds/components'
import { DEMO_MAMA_BISI_EMAIL, supabase } from '../lib/supabase'
import { call, newKey } from '../plus/api'
import { DemoChoice, useSession } from '../plus/auth'
import { LoadingList } from '../plus/ui'
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
  earned_today_text: string | null
  earned_simulated: boolean
  commission_pct: number | null
  recent: Item[]
  redeemed: Item[]
  ok?: boolean
  error?: string
  text?: string
}
const Onboarding = lazy(() => import('../onboard/Onboarding.tsx'))

type Answer = Partial<Me> & { ok?: boolean; error?: string; text?: string; amount_text?: string; attempts_left?: number }
type Tone = 'success' | 'danger' | 'neutral'

/** Status of a cash-in or redeemed code: label and colour. Confirmed ones show the verified tick. */
const STATUS: Record<string, [string, string]> = {
  awaiting_user: ['Waiting for her Yes', 'text-warning'],
  confirmed: ['Sending…', 'text-secondary'],
  on_stellar: ['Verified on Stellar', 'text-success'],
  sending: ['Sending…', 'text-secondary'],
  rejected: ['She said No', 'text-danger'],
  expired: ['Expired', 'text-secondary'],
}

export default function AgentPage() {
  useMarketAccent('ng')
  const { session, ready } = useSession()
  return (
    <div className="min-h-dvh bg-canvas text-label">
      {!ready ? null : session ? <Signed /> : (
        <DemoChoice people={[{ email: DEMO_MAMA_BISI_EMAIL, label: 'Continue as Mama Bisi', note: 'Plus cash agent · Bodija market, Ibadan' }]} />
      )}
    </div>
  )
}

function Phone({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-base font-medium text-secondary">Their phone</span>
      <input
        inputMode="tel"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0803 123 4567"
        className="num mt-1.5 block min-h-14 w-full rounded-control border border-hairline bg-surface-2 px-4 text-xl text-label transition-colors focus:border-accent focus:bg-surface focus:outline-none"
      />
    </label>
  )
}

function Signed() {
  const [me, setMe] = useState<Me | null>(null)
  const [tab, setTab] = useState<'cash' | 'code' | 'register' | 'assets'>(() => (new URLSearchParams(window.location.search).get('tab') === 'register' ? 'register' : 'cash'))
  const [phone, setPhone] = useState('+2340000000501') // Funmi (demo number)
  const [amount, setAmount] = useState('')
  const [code, setCode] = useState('')
  const [checked, setChecked] = useState<string | null>(null)
  const [key, setKey] = useState(() => newKey('agent'))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)

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
      setMsg({ tone: 'success', text: r.text ?? '' })
      setAmount('')
      setKey(newKey('agent'))
    } else setMsg({ tone: 'danger', text: r.text ?? r.error ?? 'Error' })
  }

  async function check() {
    const r = await send('check_code', { phone, code })
    if (r.ok) {
      setChecked(r.amount_text ?? null)
      setMsg({ tone: 'neutral', text: r.text ?? '' })
    } else {
      setChecked(null)
      setMsg({ tone: 'danger', text: `${r.text ?? r.error}${typeof r.attempts_left === 'number' ? ` ${r.attempts_left} tries left.` : ''}` })
    }
  }

  async function redeem() {
    const r = await send('redeem_code', { phone, code })
    setChecked(null)
    if (r.ok) {
      setCode('')
      setMsg({ tone: 'success', text: r.text ?? '' })
    } else setMsg({ tone: 'danger', text: r.text ?? r.error ?? 'Error' })
  }

  if (!me) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 pt-6">
        <p className="flex items-center gap-2 text-lg text-secondary" role="status"><Spinner /> Loading your float…</p>
        <LoadingList rows={3} />
      </div>
    )
  }
  if (me.error) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <Notice tone="danger">{me.error === 'not_an_agent' ? 'This login is not a Plus cash agent.' : me.text ?? me.error}</Notice>
        <Button variant="secondary" className="w-full" onClick={() => void supabase?.auth.signOut()}>Sign out</Button>
      </div>
    )
  }

  const items = tab === 'cash' ? me.recent : me.redeemed
  return (
    <div className="mx-auto max-w-md space-y-6 px-4 pb-16 pt-[max(env(safe-area-inset-top),1.25rem)]">
      <PageHeader
        title={me.agent.name}
        sub="Plus cash agent · Bodija market"
        right={<Button variant="secondary" size="sm" onClick={() => void supabase?.auth.signOut()}>Sign out</Button>}
      />

      <Card>
        <div className="flex items-start justify-between gap-3">
          <AmountDisplay text={me.float_text} size="lg" label="Float" />
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-xl text-accent-ink"><Icon name="wallet" /></span>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-3 text-sm">
          <div><dt className="text-secondary">Free</dt><dd className="num font-medium">{me.float_free_text}</dd></div>
          <div><dt className="text-secondary">Left today</dt><dd className="num font-medium">{me.left_today_text}</dd></div>
          <div><dt className="text-secondary">Daily limit</dt><dd className="num font-medium">{me.limit_text}</dd></div>
        </dl>
        {me.wallet_url && <div className="mt-3"><VerifiedMark url={me.wallet_url} /></div>}
      </Card>

      {me.earned_today_text && (
        <Card className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-secondary">Earned today</p>
            <p className="num text-2xl font-semibold">{me.earned_today_text}</p>
          </div>
          <p className="max-w-[55%] text-right text-sm text-secondary">{me.commission_pct}% of the cash you handled today{me.earned_simulated ? ' (simulated)' : ''}</p>
        </Card>
      )}

      <Segmented
        label="What do you want to do?"
        value={tab}
        onChange={(t) => { setTab(t); setMsg(null) }}
        options={[['cash', 'Cash in'], ['code', 'Code'], ['register', 'Register'], ['assets', 'Assets']]}
      />

      {tab === 'assets' ? <AssetChecks /> : tab === 'register' ? (
        <Card>
          <Suspense fallback={<p className="flex items-center gap-2 py-6 text-lg text-secondary" role="status"><Spinner /> Loading…</p>}>
            <Onboarding mode="agent" onExit={() => setTab('cash')} />
          </Suspense>
        </Card>
      ) : (
        <>
          <Card className="space-y-5">
            <Phone value={phone} onChange={setPhone} />
            {tab === 'cash' ? (
              <>
                <div className="text-center" aria-live="polite">
                  <p className="text-base font-medium text-secondary">Cash she gave you</p>
                  <AmountDisplay text={naira(BigInt(amount || '0') * 100n)} size="xl" className={`mt-2 ${amount ? '' : 'text-secondary'}`} />
                </div>
                <NumPad onKey={(k) => setAmount((a) => applyKey(a, k, 7))} />
                <Button className="w-full" onClick={() => void record()} disabled={!amount || !phone} loading={busy}>
                  <Icon name="cash" /> Record cash
                </Button>
                <p className="text-center text-sm text-secondary">Nothing moves until she says Yes in her Plus app.</p>
              </>
            ) : (
              <>
                <div className="text-center" aria-live="polite">
                  <p className="text-base font-medium text-secondary">Her 6-digit code</p>
                  <p className="num mt-2 font-mono text-5xl font-light tracking-[0.2em]">{code.padEnd(6, '·')}</p>
                  <p className="mt-2 text-sm text-secondary">Her own cash-out code, or a code someone sent to this phone.</p>
                </div>
                <NumPad onKey={(k) => { setCode((c) => applyKey(c, k, 6, true)); setChecked(null) }} />
                {checked ? (
                  <Button className="w-full" onClick={() => void redeem()} loading={busy}>
                    <Icon name="check" /> I gave her {checked}. Done
                  </Button>
                ) : (
                  <Button className="w-full" onClick={() => void check()} disabled={code.length !== 6 || !phone} loading={busy}>Check code</Button>
                )}
              </>
            )}
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          </Card>

          <Section title={tab === 'cash' ? 'Recent cash-ins' : 'Codes you redeemed'}>
            {items.length === 0 ? (
              <EmptyState icon={tab === 'cash' ? 'cash' : 'code'} title={tab === 'cash' ? 'No cash-ins yet' : 'No codes redeemed yet'}>
                {tab === 'cash' ? 'Cash you record shows here, with its tick once it is verified.' : 'Codes you pay out show here.'}
              </EmptyState>
            ) : (
              <ListGroup>
                {items.map((r) => {
                  const [label, cls] = STATUS[r.status] ?? [r.status, 'text-secondary']
                  return (
                    <ListRow
                      key={r.id}
                      icon={tab === 'cash' ? 'in' : 'cash'}
                      iconTone={r.status === 'on_stellar' ? 'success' : 'neutral'}
                      title={r.name}
                      subtitle={when(r.at)}
                      trailing={
                        <span className="flex flex-col items-end gap-0.5">
                          <span className="num text-lg font-medium">{r.amount_text}</span>
                          {r.status === 'on_stellar' ? (
                            <VerifiedMark url={r.url} />
                          ) : (
                            <span className={`text-xs font-medium ${cls}`}>{label}</span>
                          )}
                        </span>
                      }
                    />
                  )
                })}
              </ListGroup>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

type AssetRequest = {
  id: string; kind: 'community' | 'inspection'; owner_name: string; description: string; type: string
  estimated_value: string; value_text: string; level_text: string; status: string; evidence_at: string | null; photo_url: string | null
}

/** Customers who asked Mama Bisi to confirm an asset, and inspections waiting in her market. */
function AssetChecks() {
  const [list, setList] = useState<AssetRequest[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [value, setValue] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const load = useCallback(async () => {
    const r = await call<{ requests?: AssetRequest[] }>('agent-api/asset_requests').catch(() => ({ requests: [] }))
    setList(r.requests ?? [])
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  async function answer(q: AssetRequest, confirm: boolean) {
    setBusy(q.id)
    setMsg(null)
    const v = q.kind === 'inspection' && confirm ? value[q.id] ?? String(BigInt(q.estimated_value) / 100n) : undefined
    const r = await call<Answer>('agent-api/asset_answer', { request_id: q.id, confirm, ...(v ? { value: v } : {}) })
      .catch(() => ({ error: 'network', text: 'No connection. Try again.' }) as Answer)
    setBusy(null)
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.text ?? r.error ?? 'Error' })
    void load()
  }
  if (!list) return <LoadingList rows={2} />
  return (
    <Section title="Asset checks">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list.length === 0 ? (
        <EmptyState icon="shield" title="Nothing to check">When a customer asks you to confirm something they own, or an inspection is needed nearby, it shows here.</EmptyState>
      ) : list.map((q) => (
        <Card key={q.id} className="space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium text-secondary">
            <Icon name={q.kind === 'inspection' ? 'shield' : 'group'} /> {q.kind === 'inspection' ? 'Inspection: go and see it in person' : 'Asked you to confirm'}
          </p>
          {q.photo_url ? <img src={q.photo_url} alt={q.description} className="aspect-[4/3] w-full rounded-control object-cover" /> : null}
          <p className="text-xl font-medium">{q.owner_name}: {q.description}</p>
          <p className="text-base text-secondary">
            They say about {q.value_text} · now {q.level_text}{q.evidence_at ? ` · photo ${when(q.evidence_at)}` : ''}
          </p>
          {q.kind === 'inspection' && (
            <label className="block">
              <span className="text-base font-medium">Value you saw (naira)</span>
              <input inputMode="numeric" className="mt-1 min-h-11 w-full rounded-control bg-fill px-3 text-lg num"
                value={value[q.id] ?? String(BigInt(q.estimated_value) / 100n)}
                onChange={(e) => setValue((v) => ({ ...v, [q.id]: e.target.value.replace(/\D/g, '').slice(0, 9) }))} />
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="plain" loading={busy === q.id} onClick={() => void answer(q, false)}>{q.kind === 'inspection' ? 'Not as described' : "Can't confirm"}</Button>
            <Button loading={busy === q.id} onClick={() => void answer(q, true)}>{q.kind === 'inspection' ? 'Inspected' : 'I have seen it'}</Button>
          </div>
        </Card>
      ))}
    </Section>
  )
}
