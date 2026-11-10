// The helper page (/helper): Meena records cash a member handed her. Nothing moves until the
// member says Yes in her own Plus app; the daily limit is enforced by the database.
import { useCallback, useEffect, useState } from 'react'
import {
  AmountDisplay, Button, Card, EmptyState, Icon, ListGroup, ListRow, Notice, NumPad, Section, applyKey, useMarketAccent,
} from '../ds/components'
import { DEMO_MEENA_EMAIL, supabase } from '../lib/supabase'
import { call, newKey } from '../plus/api'
import { DemoLogin, useSession } from '../plus/auth'
import type { Key, Lang } from '../plus/i18n'
import { L, LangContext, LoadingList } from '../plus/ui'
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
  awaiting_user: ['statusAwaiting', 'text-warning'],
  confirmed: ['statusConfirmed', 'text-success'],
  rejected: ['statusRejected', 'text-danger'],
  expired: ['statusExpired', 'text-secondary'],
}

export default function HelperPage() {
  useMarketAccent('in')
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
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

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
      setMsg({ tone: 'success', text: r.text ?? '' })
      setMe(r)
      setAmount('')
      setWho(null)
      setKey(newKey('helper'))
    } else setMsg({ tone: 'danger', text: r.text ?? r.error ?? 'Error' })
  }

  if (!me) {
    return (
      <div className="mx-auto max-w-md px-4 pt-6">
        <LoadingList rows={3} />
      </div>
    )
  }
  if (me.error) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <Notice tone="danger">{me.error === 'not_a_helper' ? 'This login is not a helper.' : me.text ?? me.error}</Notice>
        <Button variant="secondary" className="w-full" onClick={() => void supabase?.auth.signOut()}>
          <L k="signOut" />
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-6 px-4 pb-16 pt-[max(env(safe-area-inset-top),1.25rem)]">
      <header className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-secondary"><L k="helperTitle" /></p>
          <h1 className="truncate text-3xl font-semibold">{me.helper.name}</h1>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void supabase?.auth.signOut()}>
          <L k="signOut" />
        </Button>
      </header>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <AmountDisplay text={me.left_today_text} size="lg" label={<L k="leftToday" />} />
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-xl text-accent-ink"><Icon name="cash" /></span>
        </div>
        <p className="num mt-3 border-t border-hairline pt-3 text-sm text-secondary">
          {me.used_today_text} used of {me.limit_text} today
        </p>
      </Card>

      <Section title={<L k="recordCash" />}>
        <Card className="space-y-5">
          <p className="text-base font-medium text-secondary"><L k="whoGaveCash" /></p>
          <ListGroup className="shadow-none! bg-surface-2!">
            {me.people.map((p) => (
              <ListRow key={p.user_id} icon="person" iconTone={who === p.user_id ? 'accent' : 'neutral'} title={p.name} selected={who === p.user_id} onClick={() => setWho(p.user_id)} />
            ))}
          </ListGroup>
          {who && (
            <>
              <div className="text-center" aria-live="polite">
                <AmountDisplay text={`₹${amount ? Number(amount).toLocaleString('en-IN') : '0'}`} size="xl" className={amount ? '' : 'text-secondary'} />
              </div>
              <NumPad onKey={(k) => setAmount((a) => applyKey(a, k, 6))} />
              <Button className="w-full" onClick={() => void record()} disabled={!amount} loading={busy}>
                <Icon name="cash" /> <L k="recordCash" sub="text-on-accent/80" />
              </Button>
            </>
          )}
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </Card>
      </Section>

      <Section title={<L k="recent" />}>
        {me.recent.length === 0 ? (
          <EmptyState icon="cash" title="Nothing recorded yet">Cash you record shows here until she says Yes.</EmptyState>
        ) : (
          <ListGroup>
            {me.recent.map((r) => {
              const [k, cls] = STATUS[r.status] ?? ['statusAwaiting', 'text-secondary']
              return (
                <ListRow
                  key={r.id}
                  icon="in"
                  iconTone={r.status === 'confirmed' ? 'success' : 'neutral'}
                  title={r.name}
                  subtitle={whenText(r.at, 'ta')}
                  trailing={
                    <span className="flex flex-col items-end gap-0.5">
                      <span className="num text-lg font-medium">{r.amount_text}</span>
                      <span className={`text-xs font-medium ${cls}`}><L k={k} sub="hidden" /></span>
                    </span>
                  }
                />
              )
            })}
          </ListGroup>
        )}
      </Section>
    </div>
  )
}
