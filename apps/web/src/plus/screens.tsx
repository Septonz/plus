// Selvi's India screens. Money only moves through prepare -> the confirm sheet -> confirm_action.
// Home is a stack of passes (Wallet, Savings, Seettu, Advance); a pass opens full-screen
// (PlusApp's CardDetail). Labels: English, with Tamil beneath in a muted line in Tamil mode.
import { useEffect, useState, type ReactNode } from 'react'
import { getMarket } from '@plus/markets'
import {
  AmountDisplay, Bilingual, Button, Card, CardStack, EmptyState, Icon, ListGroup, ListRow, Notice, NumPad, Pass, PinPad, Section,
  Segmented, Skeleton, VerifiedMark, applyKey,
} from '../ds/components'
import { call, newKey, tool, type ToolResult } from './api'
import { money, type PlusData, whenText } from './data'
import { PAYEE_TA, SOURCE_KEY, T, type Key } from './i18n'
import { ErrorState, LoadingList, useLang, useT } from './ui'

export type Screen = 'home' | 'pay' | 'seettu' | 'advance' | 'record' | 'add' | 'savings' | 'settings'
type Nav = { go: (s: Screen) => void }
const EXPLORER = 'https://stellar.expert/explorer/testnet'

/** English main, Tamil beneath (Tamil mode only), for a string key. */
function useB() {
  const { lang } = useLang()
  return (k: Key): { main: string; sub?: string } => ({ main: T[k].en, sub: lang === 'ta' ? T[k].ta : undefined })
}
function B({ k, className = '' }: { k: Key; className?: string }) {
  const b = useB()(k)
  return <Bilingual main={b.main} sub={b.sub} className={className} />
}

/** Read a composite tool (seettu, advance, record), refetching when Realtime says something changed. */
function useToolRead<R extends ToolResult>(name: string, version: number) {
  const [data, setData] = useState<R | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    tool<R>(name)
      .then((r) => live && (r.error ? setError(r.text || r.error) : setData(r)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [name, version])
  return { data, error }
}

function Loaded<R>({ data, error, rows = 3, children }: { data: R | null; error: string | null; rows?: number; children: (d: R) => ReactNode }) {
  if (error && !data) return <ErrorState text={error} onRetry={() => window.location.reload()} />
  if (!data) return <LoadingList rows={rows} />
  return <>{children(data)}</>
}

const payeeName = (name: string, lang: 'ta' | 'en') => (lang === 'ta' ? PAYEE_TA[name] ?? name : name)
const payeeIcon = (name: string) => (/flower/.test(name) ? 'flower' : /medical/.test(name) ? 'medical' : 'person')

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

type GroupStatus = ToolResult & {
  in_group: boolean
  name: string
  amount_text: string
  paid_this_period: boolean
  next_due: string | null
  members: { name: string; position: number; is_me: boolean; contributions_on_stellar: number; total_text: string; verified_on_stellar: boolean; last_url: string | null }[]
}

type AdvanceStatus = ToolResult & {
  eligible: boolean
  limit_text: string
  fee_bps: number
  options: { amount_minor: string; amount_text: string; cost_minor: string; cost_text: string }[]
  open: boolean
  owed_text: string
}

export type Detail = 'add' | 'savings' | 'seettu' | 'advance'

export function Home({ data, go, open, onOpen }: { data: PlusData; open: Detail | null; onOpen: (d: Detail) => void } & Nav) {
  const { lang, setLang } = useLang()
  const t = useT()
  const b = useB()
  const { me, account, txs, pending } = data
  const cashIns = pending.filter((a) => a.kind === 'confirm_cash_in')
  // Adjustments are demo:reset bookkeeping, not her money moving.
  const recent = txs.filter((x) => x.kind !== 'adjustment').slice(0, 5)
  const [busy, setBusy] = useState<string | null>(null)
  const { data: g } = useToolRead<GroupStatus>('group_status', data.version)
  const { data: adv } = useToolRead<AdvanceStatus>('advance_status', data.version)
  const name = me?.name ?? ''
  const autoSave = (me?.auto_save_bps ?? 0) / 100

  async function answer(id: string, yes: boolean) {
    setBusy(id)
    await tool(yes ? 'confirm_action' : 'reject_action', { action_id: id }).catch(() => null)
    setBusy(null)
    void data.refresh()
  }
  async function toggleLang() {
    const next = lang === 'ta' ? 'en' : 'ta'
    setLang(next)
    await tool('update_settings', { language: next }).catch(() => null)
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3 pt-1">
        <div className="min-w-0">
          <p className="text-base text-secondary">{lang === 'ta' ? `${T.hello.en} · ${T.hello.ta}` : T.hello.en}</p>
          <h1 className="truncate text-3xl font-semibold">{lang === 'ta' && name === 'Selvi' ? 'Selvi · செல்வி' : name}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => void toggleLang()} aria-label="Language / மொழி" className="min-h-11 rounded-full bg-fill px-3 text-sm font-medium text-label active:bg-fill-strong">
            {lang === 'ta' ? 'English' : 'தமிழ்'}
          </button>
          <button onClick={() => go('settings')} aria-label={t('profile')} className="grid size-11 place-items-center rounded-full bg-fill text-base font-semibold text-label active:bg-fill-strong">
            {name.slice(0, 1).toUpperCase() || <Icon name="profile" />}
          </button>
        </div>
      </header>

      {cashIns.map((a) => (
        <Card key={a.id} className="border border-warning/30 bg-warning-soft!">
          <p className="flex items-center gap-2 text-sm font-medium text-warning-strong">
            <Icon name="cash" /> <B k="waitingForYou" />
          </p>
          <p className="mt-2 text-xl font-medium">
            {`${String(a.params.helper_name)} says you gave her ${money(String(a.params.amount))} in cash. Is that right?`}
          </p>
          {lang === 'ta' && (
            <p className="mt-1 text-sm text-secondary">{`${String(a.params.helper_name)} நீங்க ${money(String(a.params.amount))} கையில கொடுத்ததா சொல்றாங்க. சரியா?`}</p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Button variant="secondary" onClick={() => void answer(a.id, false)} disabled={busy === a.id}>
              <Icon name="x" /> {lang === 'ta' ? `${T.no.en} · ${T.no.ta}` : T.no.en}
            </Button>
            <Button onClick={() => void answer(a.id, true)} loading={busy === a.id}>
              <Icon name="check" /> {lang === 'ta' ? `${T.yes.en} · ${T.yes.ta}` : T.yes.en}
            </Button>
          </div>
        </Card>
      ))}

      <CardStack>
        <Pass
          id="add"
          tone="wallet"
          icon="wallet"
          title={b('toSpend').main}
          sub={b('toSpend').sub}
          hidden={open === 'add'}
          onOpen={() => onOpen('add')}
          note={account ? account.bank_name : undefined}
        >
          {account ? <AmountDisplay text={money(account.balance_paise)} size="lg" /> : <Skeleton className="h-12 w-48 opacity-30" />}
        </Pass>
        <Pass
          id="savings"
          icon="savings"
          title={b('savings').main}
          sub={lang === 'ta' ? `${T.savings.ta} · ${autoSave}% ${T.autoSaveOn.ta}` : `${autoSave}% auto-save`}
          value={account ? money(account.savings_paise) : undefined}
          hidden={open === 'savings'}
          onOpen={() => onOpen('savings')}
        />
        <Pass
          id="seettu"
          icon="group"
          title={b('seettu').main}
          sub={g ? (g.in_group ? `${g.name}${lang === 'ta' ? ` · ${T.seettu.ta}` : ''}` : t('nothingYet')) : ' '}
          value={g?.in_group ? (g.paid_this_period ? T.paidThisMonth.en : g.amount_text) : undefined}
          hidden={open === 'seettu'}
          onOpen={() => onOpen('seettu')}
        />
        <Pass
          id="advance"
          icon="advance"
          title={b('advance').main}
          sub={adv ? (adv.open ? b('owed').main : adv.eligible ? b('eligible').main : b('notEligible').main) : ' '}
          value={adv ? (adv.open ? adv.owed_text : adv.eligible ? `${T.upTo.en} ${adv.limit_text}` : undefined) : undefined}
          hidden={open === 'advance'}
          onOpen={() => onOpen('advance')}
        />
      </CardStack>

      <Section
        title={<B k="recentActivity" />}
        action={recent.length > 0 && <button onClick={() => go('record')} className="min-h-11 px-1 text-base font-medium text-accent-ink">{T.seeAll.en}</button>}
      >
        {recent.length > 0 ? (
          <ListGroup>{recent.map((x) => <TxRow key={x.id} kind={x.kind} source={x.source} amount={money(x.amount)} at={x.created_at} url={x.chain_tx_hash ? `${EXPLORER}/tx/${x.chain_tx_hash}` : null} pending={!x.chain_tx_hash} />)}</ListGroup>
        ) : (
          <EmptyState icon="activity" title={<B k="nothingYet" />} />
        )}
      </Section>
    </div>
  )
}

const KIND_LABEL: Record<string, { ta: string; en: string }> = {
  incoming: { ta: 'வந்தது', en: 'Received' },
  received: { ta: 'வந்தது', en: 'Received' },
  saved: { ta: 'சேமிச்சது', en: 'Saved' },
  pay: { ta: 'அனுப்பியது', en: 'Paid' },
  paid: { ta: 'அனுப்பியது', en: 'Paid' },
  group: { ta: 'சீட்டு', en: 'Seettu' },
  group_contribution: { ta: 'சீட்டு', en: 'Seettu' },
}
const KIND_ICON: Record<string, string> = { incoming: 'in', received: 'in', saved: 'savings', pay: 'pay', paid: 'pay', group: 'group', group_contribution: 'group' }

function TxRow({ kind, source, amount, at, url, pending, dateOnly }: { kind: string; source?: string | null; amount: string; at: string; url: string | null; pending?: boolean; dateOnly?: boolean }) {
  const { lang } = useLang()
  const incoming = kind === 'incoming' || kind === 'received'
  const label = KIND_LABEL[kind]?.en ?? kind
  const src = source && SOURCE_KEY[source] ? T[SOURCE_KEY[source]] : null
  const when = dateOnly ? new Date(at).toLocaleDateString(lang === 'ta' ? 'ta-IN' : 'en-IN', { day: 'numeric', month: 'short' }) : whenText(at, lang)
  const clean = amount.replace('-', '')
  return (
    <ListRow
      icon={KIND_ICON[kind] ?? 'record'}
      iconTone={incoming ? 'success' : kind === 'saved' ? 'accent' : 'neutral'}
      title={src ? src.en : label}
      subtitle={lang === 'ta' ? `${src ? src.ta : KIND_LABEL[kind]?.ta ?? ''} · ${when}` : `${src ? `${label} · ` : ''}${when}`}
      trailing={
        <span className="flex flex-col items-end gap-0.5">
          <span className={`num text-lg font-medium ${incoming ? 'text-success' : ''}`}>{incoming ? '+' : kind === 'saved' ? '' : '−'}{clean}</span>
          {pending ? <VerifiedMark pending pendingLabel={T.confirming.en} /> : url ? <VerifiedMark url={url} label="Verified" /> : null}
        </span>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

export function Pay({ data }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const [payee, setPayee] = useState<{ id: string; name: string } | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function next() {
    if (!payee || !amount) return
    setBusy(true)
    setError(null)
    // Same tool the voice agent uses; the confirm sheet opens from the pending action.
    const r = await tool('prepare_pay', { payee: payee.name, amount: Number(amount) }).catch(() => ({ text: '', error: 'network' }) as ToolResult)
    setBusy(false)
    if (!r.ok) {
      setError(
        r.error === 'insufficient_funds'
          ? lang === 'ta' ? `போதுமான பணம் இல்ல (${String(r.balance_text ?? '')}).` : `Not enough money (${String(r.balance_text ?? '')}).`
          : r.error === 'daily_limit'
          ? lang === 'ta' ? `இன்னைக்கு வரம்பு தாண்டுது. இன்னும் ${String(r.left_today_text ?? '')} மட்டும்.` : `Over today's limit. ${String(r.left_today_text ?? '')} left today.`
          : r.text,
      )
      return
    }
    setAmount('')
    setPayee(null)
    void data.refresh()
  }

  return (
    <div className="space-y-6">
      <Section title={<B k="choosePayee" />}>
        {data.payees.length === 0 ? (
          <EmptyState icon="person" title={<B k="nothingYet" />} />
        ) : (
          <ListGroup>
            {data.payees.map((p) => (
              <ListRow
                key={p.id}
                icon={payeeIcon(p.name)}
                iconTone={payee?.id === p.id ? 'accent' : 'neutral'}
                title={<Bilingual main={p.name.charAt(0).toUpperCase() + p.name.slice(1)} sub={lang === 'ta' ? payeeName(p.name, 'ta') : undefined} />}
                subtitle={p.upi_handle ?? undefined}
                selected={payee?.id === p.id}
                onClick={() => { setPayee(p); setError(null) }}
              />
            ))}
          </ListGroup>
        )}
      </Section>

      {payee ? (
        <Section title={<B k="howMuch" />}>
          <Card className="space-y-5">
            <p className="text-center text-lg font-medium">
              <Bilingual main={`To ${payee.name}`} sub={lang === 'ta' ? `${payeeName(payee.name, 'ta')}க்கு` : undefined} />
            </p>
            <div className="py-2 text-center" aria-live="polite">
              <AmountDisplay text={money(BigInt(amount || '0') * 100n)} size="xl" className={amount ? '' : 'text-secondary'} />
            </div>
            <NumPad onKey={(k) => setAmount((a) => applyKey(a, k, 6))} clearLabel={t('clear')} />
            {error && <Notice tone="danger">{error}</Notice>}
            <Button className="w-full" onClick={() => void next()} disabled={!amount} loading={busy}>
              {lang === 'ta' ? `${T.next.en} · ${T.next.ta}` : T.next.en}
            </Button>
          </Card>
        </Section>
      ) : (
        <p className="px-1 text-center text-base text-secondary">
          {lang === 'ta' ? 'அல்லது மைக்கை தொட்டு சொல்லுங்க: “பூக்கடைக்கு 300 அனுப்பு”' : 'Or tap the mic and say “send 300 to the flower shop”'}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Seettu
// ---------------------------------------------------------------------------

export function Seettu({ data }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const { data: g, error } = useToolRead<GroupStatus>('group_status', data.version)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const myPendingContribution = data.txs.find((x) => x.kind === 'group_contribution' && !x.chain_tx_hash)

  async function payNow() {
    setBusy(true)
    setMsg(null)
    const r = await tool('prepare_group_contribution').catch(() => ({ text: '', error: 'network' }) as ToolResult)
    setBusy(false)
    if (!r.ok) setMsg(r.error === 'already_paid' ? t('paidThisMonth') : r.text)
    else void data.refresh()
  }

  return (
    <Loaded data={g} error={error} rows={4}>
      {(g) => !g.in_group ? (
        <EmptyState icon="group" title={<B k="seettu" />}>{g.text}</EmptyState>
      ) : (
        <>
          <Card className="space-y-4">
            <div>
              <h2 className="text-2xl font-semibold">{g.name}</h2>
              <p className="text-base text-secondary"><B k="thisMonth" /></p>
            </div>
            <AmountDisplay text={g.amount_text} size="lg" />
            {g.paid_this_period ? (
              <Notice tone="success"><B k="paidThisMonth" /></Notice>
            ) : (
              <>
                <p className="text-base text-secondary"><B k="notPaidYet" /></p>
                <Button className="w-full" onClick={() => void payNow()} loading={busy}>
                  {lang === 'ta' ? `${T.payNow.en} · ${T.payNow.ta}` : T.payNow.en}
                </Button>
              </>
            )}
            {msg && <Notice>{msg}</Notice>}
          </Card>

          <Section title={<B k="members" />}>
            <ListGroup>
              {g.members.map((m) => (
                <ListRow
                  key={m.position}
                  icon="person"
                  iconTone={m.is_me ? 'accent' : 'neutral'}
                  title={`${m.name}${m.is_me ? ` (${T.you.en})` : ''}`}
                  subtitle={`${m.contributions_on_stellar} ${T.contributions.en} · ${m.total_text}`}
                  trailing={
                    m.is_me && myPendingContribution ? <VerifiedMark pending pendingLabel={T.confirming.en} />
                      : m.verified_on_stellar ? <VerifiedMark url={m.last_url} label="Verified" /> : <span className="text-sm text-secondary">{T.notPaidYet.en}</span>
                  }
                />
              ))}
            </ListGroup>
            <p className="px-1 text-sm text-secondary"><B k="privacyPlain" /></p>
          </Section>
        </>
      )}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Advance
// ---------------------------------------------------------------------------

export function Advance({ data }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const { data: a, error } = useToolRead<AdvanceStatus>('advance_status', data.version)
  const [pick, setPick] = useState<string | null>(null)
  const rules = getMarket('in').advance

  return (
    <Loaded data={a} error={error} rows={2}>
      {(a) => {
        const chosen = a.options.find((o) => o.amount_minor === pick) ?? a.options.at(-1) ?? null
        return (
          <>
            {a.open ? (
              <Card>
                <AmountDisplay text={a.owed_text} size="lg" label={<B k="owed" />} />
              </Card>
            ) : a.eligible ? (
              <Card>
                <AmountDisplay text={a.limit_text} size="lg" label={<B k="eligible" />} />
              </Card>
            ) : (
              <EmptyState icon="advance" title={<B k="notEligible" />}>
                {lang === 'ta' ? `Plus மூலம் ${rules.eligibleAfterWeeks} வாரம் பணம் வந்த பிறகு கிடைக்கும்.` : `Opens after ${rules.eligibleAfterWeeks} weeks of money coming in through Plus.`}
              </EmptyState>
            )}

            {a.eligible && chosen && (
              <Section title={<B k="youGet" />}>
                <Segmented label="Amount" value={chosen.amount_minor} onChange={setPick} options={a.options.map((o) => [o.amount_minor, o.amount_text] as [string, ReactNode])} />
                <dl className="divide-y divide-hairline rounded-card bg-surface shadow-card">
                  {([
                    ['youGet', chosen.amount_text, false],
                    ['cost', `${chosen.cost_text}`, false],
                    ['youRepay', money(BigInt(chosen.amount_minor) + BigInt(chosen.cost_minor)), true],
                  ] as const).map(([k, v, strong]) => (
                    <div key={k} className="flex items-center justify-between gap-4 px-4 py-3">
                      <dt className={strong ? 'font-medium' : 'text-secondary'}><B k={k} />{k === 'cost' ? ` (${a.fee_bps / 100}%)` : ''}</dt>
                      <dd className={`num ${strong ? 'text-xl font-semibold' : 'text-lg font-medium'}`}>{v}</dd>
                    </div>
                  ))}
                </dl>
                <p className="px-1 text-sm text-secondary">
                  {lang === 'ta' ? 'ஒத்துக்கிறதுக்கு முன்னாடியே செலவு ரூபாய்ல தெரியும். வேற கட்டணம் எதுவும் இல்ல.' : 'You see the cost in rupees before you agree. No other charges.'}
                </p>
                <Button className="w-full" disabled>
                  {T.askAdvance.en} · {T.comingSoon.en}
                </Button>
              </Section>
            )}

            {!a.open && <p className="px-1 text-sm text-secondary"><B k="noAdvanceOpen" /></p>}
          </>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

type RecordResult = ToolResult & {
  totals: { received_text: string; saved_text: string; paid_text: string; group_text: string }
  confirmed_on_stellar: number
  waiting_for_stellar: number
  history: { type: string; kind: string; amount_text: string; at: string; url: string | null }[]
  recent: { id: string; kind: string; source: string | null; amount_text: string; at: string; on_stellar: boolean; url: string | null }[]
  record_url: string | null
}

export function Record({ data }: { data: PlusData } & Nav) {
  const { data: r, error } = useToolRead<RecordResult>('my_record', data.version)
  return (
    <Loaded data={r} error={error} rows={4}>
      {(r) => {
        const older = r.history.filter((h) => !r.recent.some((x) => x.url === h.url))
        return (
          <div className="space-y-6">
            <Card>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
                {([
                  ['received', r.totals.received_text],
                  ['saved', r.totals.saved_text],
                  ['paidOut', r.totals.paid_text],
                  ['intoSeettu', r.totals.group_text],
                ] as const).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-sm text-secondary"><B k={k} /></dt>
                    <dd className="num text-2xl font-light">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                <p className="text-sm text-secondary">
                  <span className="num">{r.confirmed_on_stellar}</span> <B k="recordsCheckable" />
                  {r.waiting_for_stellar > 0 && <span className="block">+{r.waiting_for_stellar} · {T.confirming.en}</span>}
                </p>
                {r.record_url && <VerifiedMark url={r.record_url} />}
              </div>
            </Card>

            {r.recent.length + older.length === 0 ? (
              <EmptyState icon="activity" title={<B k="nothingYet" />} />
            ) : (
              <Section title={<B k="history" />}>
                <ListGroup>
                  {r.recent.filter((x) => x.kind !== 'adjustment').map((x) => <TxRow key={x.id} kind={x.kind} source={x.source} amount={x.amount_text} at={x.at} url={x.url} pending={!x.on_stellar} />)}
                  {older.map((h, i) => <TxRow key={`h${i}`} kind={h.kind} amount={h.amount_text} at={h.at} url={h.url} dateOnly />)}
                </ListGroup>
              </Section>
            )}
            <p className="px-1 text-center text-sm text-secondary"><B k="privacyPlain" /></p>
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Add money (the wallet pass, opened)
// ---------------------------------------------------------------------------

export function AddMoney({ data }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const { account } = data

  async function simulate(endpoint: 'state_transfer_arrives' | 'wages_arrive', amount?: number) {
    setBusy(true)
    setMsg(null)
    const r = await call<ToolResult>(`payout-sim/${endpoint}`, { idempotency_key: newKey('app'), ...(amount ? { amount } : {}) }).catch(
      () => ({ text: '', ok: false, error: 'network' }) as ToolResult,
    )
    setBusy(false)
    if (r.ok) {
      setMsg({ tone: 'success', text: `${String(r.amount_text)} ${t('arrived')}. ${t('toSpend')}: ${String(r.balance_text)} · ${t('saved')}: ${String(r.savings_text)}` })
      void data.refresh()
    } else setMsg({ tone: 'danger', text: r.text || String(r.error) })
  }

  const ways = [
    ['gov', 'stateTransfer', { ta: 'மாசா மாசம் அரசு உதவி நேரா உங்க கணக்குக்கு வரும்.', en: 'Government support arrives straight in your account.' }],
    ['wages', 'wages', { ta: 'வேலை கூலி உங்க கணக்குக்கு.', en: 'Your wages, paid into your account.' }],
    ['hand', 'cashHelper', { ta: 'மீனா கிட்ட கையில கொடுங்க. நீங்க “ஆமா” சொன்னதும் கணக்குல சேரும்.', en: 'Hand cash to Meena. It counts once you say Yes.' }],
    ['globe', 'familyAbroad', { ta: 'வெளிநாட்டுல இருந்து குடும்பம் அனுப்பலாம்.', en: 'Family abroad can send money to you.' }],
  ] as const

  return (
    <>
      <div className="rounded-card p-6 text-white shadow-lift" style={{ background: 'var(--wallet)' }}>
        {account ? (
          <AmountDisplay text={money(account.balance_paise)} size="xl" label={lang === 'ta' ? `${T.toSpend.en} · ${T.toSpend.ta}` : T.toSpend.en} />
        ) : (
          <Skeleton className="h-14 w-56 opacity-30" />
        )}
        {account && <p className="mt-3 text-sm text-white/75">{account.bank_name}</p>}
      </div>

      <Section title={<B k="waysIn" />}>
        <ListGroup>
          {ways.map(([icon, k, help]) => (
            <ListRow key={k} icon={icon} iconTone="accent" title={<B k={k} />} subtitle={lang === 'ta' ? help.ta : help.en} />
          ))}
        </ListGroup>
      </Section>

      <Card className="space-y-4 border border-dashed border-fill-strong bg-surface-2! shadow-none!">
        <p className="flex items-center gap-2 text-sm font-medium text-secondary"><Icon name="star4" /> <B k="demo" /></p>
        <Button variant="secondary" className="w-full" onClick={() => void simulate('state_transfer_arrives')} disabled={busy}>
          <Icon name="gov" /> {T.demoStateTransfer.en}
        </Button>
        <div className="grid grid-cols-2 gap-3">
          {[500, 1500].map((a) => (
            <Button key={a} variant="secondary" onClick={() => void simulate('wages_arrive', a)} disabled={busy}>
              <Icon name="wages" /> {T.wages.en} ₹{a.toLocaleString('en-IN')}
            </Button>
          ))}
        </div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Savings (auto-save)
// ---------------------------------------------------------------------------

export function Savings({ data }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const current = (data.me?.auto_save_bps ?? 1000) / 100
  const [percent, setPercent] = useState<number | null>(null)
  const shown = percent ?? current
  const [msg, setMsg] = useState<string | null>(null)

  async function saveAutoSave() {
    // Two-step like every change: prepare here, the confirm sheet asks Yes/No.
    const r = await tool('set_auto_save', { percent: shown })
    if (!r.ok) setMsg(r.text)
    else {
      setPercent(null)
      void data.refresh()
    }
  }

  return (
    <>
      <Card>
        {data.account ? <AmountDisplay text={money(data.account.savings_paise)} size="xl" label={<B k="saved" />} /> : <Skeleton className="h-14 w-48" />}
      </Card>
      <Section title={<B k="autoSave" />}>
        <Card className="space-y-4">
          <p className="text-base text-secondary"><Bilingual main={T.autoSaveHelp.en} sub={lang === 'ta' ? T.autoSaveHelp.ta : undefined} /></p>
          <div className="flex items-center justify-between gap-3">
            <button aria-label="Less" onClick={() => setPercent(Math.max(0, shown - 5))} className="grid size-14 place-items-center rounded-full bg-fill text-2xl active:bg-fill-strong">−</button>
            <span className="num text-5xl font-light">{shown}%</span>
            <button aria-label="More" onClick={() => setPercent(Math.min(30, shown + 5))} className="grid size-14 place-items-center rounded-full bg-fill text-2xl active:bg-fill-strong">+</button>
          </div>
          <Button className="w-full" onClick={() => void saveAutoSave()} disabled={shown === current}>
            {lang === 'ta' ? `${T.save.en} · ${T.save.ta}` : T.save.en}
          </Button>
          {msg && <Notice tone="danger">{msg}</Notice>}
        </Card>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export function Settings({ data, onSignOut }: { data: PlusData; onSignOut: () => void } & Nav) {
  const { lang, setLang } = useLang()
  const t = useT()
  const [phone, setPhone] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pinStep, setPinStep] = useState<'idle' | 'current' | 'new'>('idle')
  const [curPin, setCurPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [hasPin, setHasPin] = useState<boolean | null>(null)
  const name = data.me?.name ?? ''

  useEffect(() => {
    tool<ToolResult & { has_pin: boolean }>('get_user').then((r) => setHasPin(Boolean(r.has_pin))).catch(() => setHasPin(null))
  }, [data.version])

  async function saveContact() {
    const r = await tool('update_settings', { trusted_contact_phone: phone ?? '' })
    setMsg(r.ok ? t('saveDone') : r.error === 'invalid_phone' ? (lang === 'ta' ? '10 இலக்க மொபைல் நம்பர் போடுங்க' : 'Use a 10-digit mobile number') : r.text)
    if (r.ok) void data.refresh()
  }
  async function chooseLang(l: 'ta' | 'en') {
    setLang(l)
    await tool('update_settings', { language: l }).catch(() => null)
  }
  async function savePin() {
    const r = await tool('set_pin', hasPin ? { pin: newPin, current_pin: curPin } : { pin: newPin })
    setCurPin('')
    setNewPin('')
    setPinStep('idle')
    setMsg(r.ok ? t('saveDone') : lang === 'ta' ? 'PIN மாத்த முடியல. இப்போ இருக்குற PIN சரியா?' : r.text)
    if (r.ok) setHasPin(true)
  }
  const both = (k: Key) => (lang === 'ta' ? `${T[k].en} · ${T[k].ta}` : T[k].en)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-full bg-accent-soft text-2xl font-medium text-accent-ink">{name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-semibold">{name}</p>
          {data.account && <p className="text-base text-secondary">{data.account.bank_name}</p>}
        </div>
      </div>
      {msg && <Notice tone="success">{msg}</Notice>}

      <Section title={<B k="language" />}>
        <Segmented label="Language / மொழி" value={lang} onChange={(l) => void chooseLang(l)} options={[['ta', 'தமிழ்'], ['en', 'English']]} />
      </Section>

      <Section title={<B k="trustedContact" />}>
        <Card className="space-y-3">
          <p className="text-sm text-secondary"><Bilingual main={T.trustedHelp.en} sub={lang === 'ta' ? T.trustedHelp.ta : undefined} /></p>
          <input
            inputMode="tel"
            autoComplete="tel"
            aria-label={t('trustedContact')}
            value={phone ?? data.me?.trusted_contact_phone ?? ''}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="98765 43210"
            className="block min-h-14 w-full rounded-control border border-hairline bg-surface-2 px-4 text-xl text-label focus:border-accent focus:bg-surface focus:outline-none"
          />
          <Button variant="secondary" className="w-full" onClick={() => void saveContact()} disabled={phone === null}>
            {both('save')}
          </Button>
        </Card>
      </Section>

      <Section title={<B k="pin" />}>
        <Card className="space-y-3">
          {pinStep === 'idle' ? (
            <Button variant="secondary" className="w-full" onClick={() => setPinStep(hasPin ? 'current' : 'new')}>
              <Icon name="lock" /> {both(hasPin ? 'changePin' : 'setPin')}
            </Button>
          ) : (
            <>
              <PinPad
                value={pinStep === 'current' ? curPin : newPin}
                onChange={pinStep === 'current' ? setCurPin : setNewPin}
                label={both(pinStep === 'current' ? 'currentPin' : 'newPin')}
                hint={both('pinHidden')}
              />
              <div className="grid grid-cols-2 gap-3">
                <Button variant="secondary" onClick={() => { setPinStep('idle'); setCurPin(''); setNewPin('') }}>
                  {both('back')}
                </Button>
                {pinStep === 'current' ? (
                  <Button onClick={() => setPinStep('new')} disabled={curPin.length < 4}>{both('next')}</Button>
                ) : (
                  <Button onClick={() => void savePin()} disabled={newPin.length < 4}>{both('save')}</Button>
                )}
              </div>
            </>
          )}
        </Card>
      </Section>

      <Button variant="destructive" className="w-full" onClick={onSignOut}>
        <Icon name="signOut" /> {both('signOut')}
      </Button>
      <p className="text-center text-sm text-secondary"><B k="demoNote" /></p>
    </div>
  )
}

