// The seven screens. Money only moves through prepare -> the confirm screen -> confirm_action.
import { useEffect, useState } from 'react'
import { getMarket } from '@plus/markets'
import { call, newKey, tool, type ToolResult } from './api'
import { money, type PlusData, whenText } from './data'
import { PAYEE_TA, SOURCE_KEY, T } from './i18n'
import { applyKey, BigButton, Card, Icon, Keypad, L, Notice, PinDots, ScreenTitle, StellarMark, useLang, useT } from './ui'
import { VoiceButton } from './voice'

export type Screen = 'home' | 'pay' | 'seettu' | 'advance' | 'record' | 'add' | 'settings'
type Nav = { go: (s: Screen) => void }

/** Read a composite tool (seettu, advance, record), refetching when Realtime says something changed. */
function useToolRead<T extends ToolResult>(name: string, version: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    tool<T>(name)
      .then((r) => live && (r.error ? setError(r.text || r.error) : setData(r)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [name, version])
  return { data, error }
}

function Loading() {
  const t = useT()
  return <p className="py-10 text-center text-xl text-ink-soft">{t('working')}</p>
}

// ---------------------------------------------------------------------------
// 1. Home
// ---------------------------------------------------------------------------

export function Home({ data, go }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const { me, account, txs, pending } = data
  const cashIns = pending.filter((a) => a.kind === 'confirm_cash_in')
  const latest = txs.find((x) => x.kind === 'incoming')
  const [busy, setBusy] = useState<string | null>(null)

  async function answer(id: string, yes: boolean) {
    setBusy(id)
    await tool(yes ? 'confirm_action' : 'reject_action', { action_id: id }).catch(() => null)
    setBusy(null)
    void data.refresh()
  }

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between">
        <h1 className="text-3xl font-extrabold">
          {lang === 'ta' ? `வணக்கம், ${me?.name === 'Selvi' ? 'செல்வி' : me?.name ?? ''}!` : `Hello, ${me?.name ?? ''}!`}
        </h1>
      </header>

      <Card className="bg-brick! text-cream">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <L k="toSpend" sub="text-cream/80" className="text-lg font-semibold" />
            <p className="mt-1 text-4xl font-extrabold">{account ? money(account.balance_paise) : '—'}</p>
          </div>
          <div>
            <L k="saved" sub="text-cream/80" className="text-lg font-semibold" />
            <p className="mt-1 text-4xl font-extrabold text-turmeric">{account ? money(account.savings_paise) : '—'}</p>
          </div>
        </div>
        {account && <p className="mt-3 text-base text-cream/80">{account.bank_name}</p>}
      </Card>

      {cashIns.map((a) => (
        <Card key={a.id} className="border-4 border-turmeric">
          <p className="text-base font-bold uppercase tracking-wide text-saffron">{t('waitingForYou')}</p>
          <p className="mt-2 text-2xl font-bold">
            {lang === 'ta'
              ? `${String(a.params.helper_name)} நீங்க ${money(String(a.params.amount))} கையில கொடுத்ததா சொல்றாங்க. சரியா?`
              : `${String(a.params.helper_name)} says you gave her ${money(String(a.params.amount))} in cash. Is that right?`}
          </p>
          {lang === 'ta' && <p className="mt-1 text-lg text-ink-soft">{a.readback}</p>}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <BigButton tone="white" onClick={() => answer(a.id, false)} disabled={busy === a.id}>
              <Icon name="x" /> <L k="no" />
            </BigButton>
            <BigButton tone="leaf" onClick={() => answer(a.id, true)} disabled={busy === a.id}>
              <Icon name="check" /> <L k="yes" sub="text-white/85" />
            </BigButton>
          </div>
        </Card>
      ))}

      <div className="py-2">
        <VoiceButton size="hero" />
      </div>

      <Card>
        <L k="latestIn" className="text-lg font-bold text-ink-soft" />
        {latest ? (
          <div className="mt-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-3xl font-extrabold text-leaf">+{money(latest.amount)}</p>
              <p className="text-lg">
                {latest.source && SOURCE_KEY[latest.source] ? T[SOURCE_KEY[latest.source]][lang] : latest.source} · {whenText(latest.created_at, lang)}
              </p>
            </div>
            {latest.chain_tx_hash ? <StellarMark url={`https://stellar.expert/explorer/testnet/tx/${latest.chain_tx_hash}`} /> : null}
          </div>
        ) : (
          <p className="mt-2 text-xl">{t('nothingYet')}</p>
        )}
      </Card>

      <nav className="grid grid-cols-2 gap-3" aria-label="Plus">
        {(
          [
            ['pay', 'pay', 'pay'],
            ['seettu', 'group', 'seettu'],
            ['advance', 'advance', 'advance'],
            ['record', 'record', 'record'],
            ['add', 'add', 'addMoney'],
            ['settings', 'settings', 'settings'],
          ] as const
        ).map(([s, icon, k]) => (
          <button
            key={s}
            onClick={() => go(s)}
            className="flex min-h-24 flex-col items-start justify-between gap-2 rounded-3xl bg-white p-4 text-left shadow-[0_2px_0_0_var(--color-sand-deep)] active:bg-sand"
          >
            <span className="grid size-11 place-items-center rounded-full bg-sand text-2xl text-brick">
              <Icon name={icon} />
            </span>
            <L k={k} className="text-xl font-bold" />
          </button>
        ))}
      </nav>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Pay
// ---------------------------------------------------------------------------

export function Pay({ data, go }: { data: PlusData } & Nav) {
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
    // Same tool the voice agent uses; the confirm screen opens from the pending action.
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

  if (!payee) {
    return (
      <div>
        <ScreenTitle k="pay" onBack={() => go('home')} />
        <p className="mb-4 text-2xl font-bold">
          <L k="choosePayee" />
        </p>
        <div className="space-y-3">
          {data.payees.map((p) => (
            <button
              key={p.id}
              onClick={() => setPayee(p)}
              className="flex w-full items-center gap-4 rounded-3xl bg-white p-5 text-left shadow-[0_2px_0_0_var(--color-sand-deep)] active:bg-sand"
            >
              <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-sand text-4xl text-brick">
                <Icon name={/flower/.test(p.name) ? 'flower' : /medical/.test(p.name) ? 'medical' : 'person'} />
              </span>
              <span className="flex flex-col">
                <span className="text-2xl font-bold">{lang === 'ta' ? PAYEE_TA[p.name] ?? p.name : p.name}</span>
                {lang === 'ta' && <span className="text-lg text-ink-soft">{p.name}</span>}
                <span className="text-base text-ink-soft">{p.upi_handle}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-6 text-center text-lg text-ink-soft">
          {lang === 'ta' ? '“பூக்கடைக்கு 300 அனுப்பு” னு சொல்லலாம்' : 'Or just say “send 300 to the flower shop”'}
        </p>
        <div className="mt-3">
          <VoiceButton size="dock" />
        </div>
      </div>
    )
  }

  return (
    <div>
      <ScreenTitle k="howMuch" onBack={() => setPayee(null)} />
      <p className="text-2xl font-bold">{lang === 'ta' ? `${PAYEE_TA[payee.name] ?? payee.name}க்கு` : `To ${payee.name}`}</p>
      <p className="my-5 text-center text-6xl font-extrabold text-brick" aria-live="polite">
        ₹{amount ? Number(amount).toLocaleString('en-IN') : '0'}
      </p>
      {error && (
        <div className="mb-3">
          <Notice tone="chili">{error}</Notice>
        </div>
      )}
      <Keypad onKey={(k) => setAmount((a) => applyKey(a, k, 6))} />
      <BigButton className="mt-4 w-full" onClick={next} disabled={!amount || busy}>
        {busy ? t('working') : <L k="next" sub="text-cream/80" />}
      </BigButton>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. Seettu
// ---------------------------------------------------------------------------

type GroupStatus = ToolResult & {
  in_group: boolean
  name: string
  amount_text: string
  paid_this_period: boolean
  next_due: string | null
  members: { name: string; position: number; is_me: boolean; contributions_on_stellar: number; total_text: string; verified_on_stellar: boolean; last_url: string | null }[]
}

export function Seettu({ data, go }: { data: PlusData } & Nav) {
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
    <div>
      <ScreenTitle k="seettu" onBack={() => go('home')} />
      {error && <Notice tone="chili">{error}</Notice>}
      {!g ? (
        <Loading />
      ) : !g.in_group ? (
        <Notice>{g.text}</Notice>
      ) : (
        <div className="space-y-5">
          <Card>
            <L k="thisMonth" className="text-lg font-bold text-ink-soft" />
            <p className="mt-1 text-5xl font-extrabold text-brick">{g.amount_text}</p>
            {g.paid_this_period ? (
              <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-leaf-soft px-4 py-2 text-lg font-bold text-leaf">
                <Icon name="check" /> {t('paidThisMonth')}
              </p>
            ) : (
              <>
                <p className="mt-2 text-lg">{t('notPaidYet')}</p>
                <BigButton className="mt-4 w-full" onClick={payNow} disabled={busy}>
                  {busy ? t('working') : <L k="payNow" sub="text-cream/80" />}
                </BigButton>
              </>
            )}
            {msg && (
              <div className="mt-3">
                <Notice>{msg}</Notice>
              </div>
            )}
          </Card>

          <h2 className="text-2xl font-extrabold">
            <L k="members" />
          </h2>
          <ul className="space-y-3">
            {g.members.map((m) => (
              <li key={m.position} className={`rounded-3xl bg-white p-4 shadow-[0_2px_0_0_var(--color-sand-deep)] ${m.is_me ? 'border-4 border-turmeric' : ''}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="grid size-12 place-items-center rounded-full bg-sand text-xl font-extrabold text-brick">{m.position + 1}</span>
                    <div>
                      <p className="text-xl font-bold">
                        {m.name} {m.is_me && <span className="text-lg text-ink-soft">({t('you')})</span>}
                      </p>
                      <p className="text-base text-ink-soft">
                        {m.contributions_on_stellar} {t('contributions')} · {m.total_text}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {m.verified_on_stellar && <StellarMark url={m.last_url} />}
                  {m.is_me && myPendingContribution && <StellarMark pending />}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-center text-base text-ink-soft">{lang === 'ta' ? T.privacyNote.ta : T.privacyNote.en}</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 4. Advance
// ---------------------------------------------------------------------------

type AdvanceStatus = ToolResult & {
  eligible: boolean
  limit_text: string
  fee_bps: number
  options: { amount_minor: string; amount_text: string; cost_minor: string; cost_text: string }[]
  open: boolean
  owed_text: string
}

export function Advance({ data, go }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const { data: a, error } = useToolRead<AdvanceStatus>('advance_status', data.version)
  const [pick, setPick] = useState<number>(-1)
  const chosen = a && a.options.length > 0 ? a.options[pick < 0 ? a.options.length - 1 : pick] : null
  const rules = getMarket('in').advance

  return (
    <div>
      <ScreenTitle k="advance" onBack={() => go('home')} />
      {error && <Notice tone="chili">{error}</Notice>}
      {!a ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <Card className={a.eligible ? 'border-4 border-leaf' : ''}>
            <p className={`text-2xl font-extrabold ${a.eligible ? 'text-leaf' : 'text-ink-soft'}`}>
              <L k={a.eligible ? 'eligible' : 'notEligible'} />
            </p>
            {a.eligible && (
              <p className="mt-2 text-xl">
                {t('upTo')} <span className="text-4xl font-extrabold text-brick">{a.limit_text}</span>
              </p>
            )}
            {!a.eligible && !a.open && (
              <p className="mt-2 text-lg">
                {lang === 'ta' ? `Plus மூலம் ${rules.eligibleAfterWeeks} வாரம் பணம் வந்த பிறகு கிடைக்கும்.` : `Opens after ${rules.eligibleAfterWeeks} weeks of money coming in through Plus.`}
              </p>
            )}
          </Card>

          {a.eligible && chosen && (
            <Card>
              <div className="flex flex-wrap gap-2">
                {a.options.map((o, i) => (
                  <button
                    key={o.amount_minor}
                    onClick={() => setPick(i)}
                    className={`min-h-14 rounded-2xl px-4 text-xl font-bold ${o === chosen ? 'bg-brick text-cream' : 'bg-sand text-ink'}`}
                  >
                    {o.amount_text}
                  </button>
                ))}
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-y-3 text-xl">
                <dt><L k="youGet" /></dt>
                <dd className="text-right text-2xl font-extrabold">{chosen.amount_text}</dd>
                <dt><L k="cost" /> ({a.fee_bps / 100}%)</dt>
                <dd className="text-right text-2xl font-extrabold text-chili">{chosen.cost_text}</dd>
                <dt><L k="youRepay" /></dt>
                <dd className="text-right text-2xl font-extrabold">{money(BigInt(chosen.amount_minor) + BigInt(chosen.cost_minor))}</dd>
              </dl>
              <p className="mt-4 text-lg text-ink-soft">
                {lang === 'ta' ? 'ஒத்துக்கிறதுக்கு முன்னாடியே செலவு ரூபாய்ல தெரியும். வேற கட்டணம் எதுவும் இல்ல.' : 'You see the cost in rupees before you agree. No other charges.'}
              </p>
              <BigButton className="mt-4 w-full" disabled>
                <L k="askAdvance" sub="text-cream/80" /> · {t('comingSoon')}
              </BigButton>
            </Card>
          )}

          <Card>
            <p className="text-xl font-bold">{a.open ? <><L k="owed" />: {a.owed_text}</> : <L k="noAdvanceOpen" />}</p>
          </Card>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 5. My record
// ---------------------------------------------------------------------------

type RecordResult = ToolResult & {
  totals: { received_text: string; saved_text: string; paid_text: string; group_text: string }
  confirmed_on_stellar: number
  waiting_for_stellar: number
  history: { type: string; kind: string; amount_text: string; at: string; url: string | null }[]
  recent: { id: string; kind: string; source: string | null; amount_text: string; at: string; on_stellar: boolean; url: string | null }[]
  record_url: string | null
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

export function Record({ data, go }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const { data: r, error } = useToolRead<RecordResult>('my_record', data.version)
  const label = (k: string) => (KIND_LABEL[k] ? KIND_LABEL[k][lang] : k)

  return (
    <div>
      <ScreenTitle k="record" onBack={() => go('home')} />
      {error && <Notice tone="chili">{error}</Notice>}
      {!r ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['received', r.totals.received_text, 'text-leaf'],
                ['saved', r.totals.saved_text, 'text-saffron'],
                ['paidOut', r.totals.paid_text, 'text-brick'],
                ['intoSeettu', r.totals.group_text, 'text-sky'],
              ] as const
            ).map(([k, v, c]) => (
              <Card key={k} className="p-4!">
                <L k={k} className="text-lg font-bold text-ink-soft" />
                <p className={`mt-1 text-3xl font-extrabold ${c}`}>{v}</p>
              </Card>
            ))}
          </div>

          <Card className="bg-leaf-soft!">
            <p className="text-5xl font-extrabold text-leaf">{r.confirmed_on_stellar}</p>
            <L k="confirmedOnStellar" className="text-xl font-bold" />
            {r.waiting_for_stellar > 0 && <p className="mt-2 text-lg">⏳ +{r.waiting_for_stellar} · {t('waitingForStellar')}</p>}
            {r.record_url && (
              <a href={r.record_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-lg font-bold text-sky underline">
                <Icon name="link" /> {t('openStellar')}
              </a>
            )}
            <p className="mt-2 text-base text-ink-soft">{t('privacyNote')}</p>
          </Card>

          <h2 className="text-2xl font-extrabold">
            <L k="history" />
          </h2>
          <ul className="space-y-2">
            {r.recent.map((x) => (
              <li key={x.id} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-[0_2px_0_0_var(--color-sand-deep)]">
                <div>
                  <p className="text-xl font-bold">{x.kind === 'incoming' ? '+' : ''}{x.amount_text.replace('-', '−')}</p>
                  <p className="text-base text-ink-soft">
                    {label(x.kind)}
                    {x.source && SOURCE_KEY[x.source] ? ` · ${T[SOURCE_KEY[x.source]][lang]}` : ''} · {whenText(x.at, lang)}
                  </p>
                </div>
                {x.on_stellar ? <StellarMark url={x.url} /> : <StellarMark pending />}
              </li>
            ))}
            {r.history
              .filter((h) => !r.recent.some((x) => x.url === h.url))
              .map((h, i) => (
                <li key={`h${i}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white p-4 shadow-[0_2px_0_0_var(--color-sand-deep)]">
                  <div>
                    <p className="text-xl font-bold">{h.amount_text}</p>
                    <p className="text-base text-ink-soft">
                      {label(h.kind)} · {new Date(h.at).toLocaleDateString(lang === 'ta' ? 'ta-IN' : 'en-IN', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                  <StellarMark url={h.url} />
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 6. Add money
// ---------------------------------------------------------------------------

export function AddMoney({ data, go }: { data: PlusData } & Nav) {
  const { lang } = useLang()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'leaf' | 'chili'; text: string } | null>(null)

  async function simulate(endpoint: 'state_transfer_arrives' | 'wages_arrive', amount?: number) {
    setBusy(true)
    setMsg(null)
    const r = await call<ToolResult>(`payout-sim/${endpoint}`, { idempotency_key: newKey('app'), ...(amount ? { amount } : {}) }).catch(
      () => ({ text: '', ok: false, error: 'network' }) as ToolResult,
    )
    setBusy(false)
    if (r.ok) {
      setMsg({ tone: 'leaf', text: `${String(r.amount_text)} ${t('arrived')} ✓  ${t('toSpend')}: ${String(r.balance_text)} · ${t('saved')}: ${String(r.savings_text)}` })
      void data.refresh()
    } else setMsg({ tone: 'chili', text: r.text || String(r.error) })
  }

  const ways = [
    ['gov', 'stateTransfer', { ta: 'மாசா மாசம் அரசு உதவி நேரா உங்க கணக்குக்கு வரும்.', en: 'Government support arrives straight in your account.' }],
    ['wages', 'wages', { ta: 'வேலை கூலி உங்க கணக்குக்கு.', en: 'Your wages, paid into your account.' }],
    ['hand', 'cashHelper', { ta: 'மீனா கிட்ட கையில கொடுங்க. நீங்க “ஆமா” சொன்னதும் கணக்குல சேரும்.', en: 'Hand cash to Meena. It counts once you say Yes.' }],
    ['globe', 'familyAbroad', { ta: 'வெளிநாட்டுல இருந்து குடும்பம் அனுப்பலாம்.', en: 'Family abroad can send money to you.' }],
  ] as const

  return (
    <div>
      <ScreenTitle k="addMoney" onBack={() => go('home')} />
      <h2 className="mb-3 text-2xl font-extrabold">
        <L k="waysIn" />
      </h2>
      <ul className="space-y-3">
        {ways.map(([icon, k, help]) => (
          <li key={k} className="flex gap-4 rounded-3xl bg-white p-4 shadow-[0_2px_0_0_var(--color-sand-deep)]">
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-sand text-3xl text-brick">
              <Icon name={icon} />
            </span>
            <div>
              <L k={k} className="text-xl font-bold" />
              <p className="mt-1 text-lg text-ink-soft">{help[lang]}</p>
            </div>
          </li>
        ))}
      </ul>

      <Card className="mt-6 border-4 border-dashed border-sand-deep">
        <p className="text-base font-bold uppercase tracking-wide text-saffron">{t('demo')}</p>
        <div className="mt-3 space-y-3">
          <BigButton className="w-full" onClick={() => simulate('state_transfer_arrives')} disabled={busy}>
            <Icon name="gov" /> <L k="demoStateTransfer" sub="text-cream/80" />
          </BigButton>
          <div className="grid grid-cols-2 gap-3">
            {[500, 1500].map((a) => (
              <BigButton key={a} tone="sand" onClick={() => simulate('wages_arrive', a)} disabled={busy}>
                <Icon name="wages" /> {t('wages')} ₹{a.toLocaleString('en-IN')}
              </BigButton>
            ))}
          </div>
        </div>
        {msg && (
          <div className="mt-3">
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 7. Settings
// ---------------------------------------------------------------------------

export function Settings({ data, go, onSignOut }: { data: PlusData; onSignOut: () => void } & Nav) {
  const { lang, setLang } = useLang()
  const t = useT()
  const current = (data.me?.auto_save_bps ?? 1000) / 100
  const [percent, setPercent] = useState<number | null>(null)
  const shown = percent ?? current
  const [phone, setPhone] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pinStep, setPinStep] = useState<'idle' | 'current' | 'new'>('idle')
  const [curPin, setCurPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [hasPin, setHasPin] = useState<boolean | null>(null)

  useEffect(() => {
    tool<ToolResult & { has_pin: boolean }>('get_user').then((r) => setHasPin(Boolean(r.has_pin))).catch(() => setHasPin(null))
  }, [data.version])

  async function saveAutoSave() {
    // Two-step like every change: prepare here, the confirm screen asks Yes/No.
    const r = await tool('set_auto_save', { percent: shown })
    if (!r.ok) setMsg(r.text)
    else void data.refresh()
  }
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

  return (
    <div className="space-y-5">
      <ScreenTitle k="settings" onBack={() => go('home')} />
      {msg && <Notice tone="leaf">{msg}</Notice>}

      <Card>
        <L k="autoSave" className="text-2xl font-extrabold" />
        <p className="mt-1 text-lg text-ink-soft">{lang === 'ta' ? T.autoSaveHelp.ta : T.autoSaveHelp.en}</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <button aria-label="−" onClick={() => setPercent(Math.max(0, shown - 5))} className="size-16 rounded-2xl bg-sand text-4xl font-bold">−</button>
          <span className="text-5xl font-extrabold text-brick">{shown}%</span>
          <button aria-label="+" onClick={() => setPercent(Math.min(30, shown + 5))} className="size-16 rounded-2xl bg-sand text-4xl font-bold">+</button>
        </div>
        <BigButton className="mt-4 w-full" onClick={saveAutoSave} disabled={shown === current}>
          <L k="save" sub="text-cream/80" />
        </BigButton>
      </Card>

      <Card>
        <L k="trustedContact" className="text-2xl font-extrabold" />
        <p className="mt-1 text-lg text-ink-soft">{lang === 'ta' ? T.trustedHelp.ta : T.trustedHelp.en}</p>
        <input
          inputMode="tel"
          autoComplete="tel"
          aria-label={t('trustedContact')}
          value={phone ?? data.me?.trusted_contact_phone ?? ''}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="98765 43210"
          className="mt-3 h-16 w-full rounded-2xl border-2 border-sand-deep bg-cream px-4 text-2xl font-bold"
        />
        <BigButton tone="sand" className="mt-3 w-full" onClick={saveContact} disabled={phone === null}>
          <L k="save" />
        </BigButton>
      </Card>

      <Card>
        <L k="language" className="text-2xl font-extrabold" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <BigButton tone={lang === 'ta' ? 'brick' : 'white'} onClick={() => chooseLang('ta')}>தமிழ்</BigButton>
          <BigButton tone={lang === 'en' ? 'brick' : 'white'} onClick={() => chooseLang('en')}>English</BigButton>
        </div>
      </Card>

      <Card>
        <L k="pin" className="text-2xl font-extrabold" />
        {pinStep === 'idle' ? (
          <BigButton tone="sand" className="mt-3 w-full" onClick={() => setPinStep(hasPin ? 'current' : 'new')}>
            <Icon name="lock" /> <L k={hasPin ? 'changePin' : 'setPin'} />
          </BigButton>
        ) : (
          <div className="mt-3">
            <p className="text-center text-xl font-bold">
              <L k={pinStep === 'current' ? 'currentPin' : 'newPin'} />
            </p>
            <PinDots length={(pinStep === 'current' ? curPin : newPin).length} />
            <Keypad onKey={(k) => (pinStep === 'current' ? setCurPin((p) => applyKey(p, k, 6, true)) : setNewPin((p) => applyKey(p, k, 6, true)))} />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <BigButton tone="white" onClick={() => { setPinStep('idle'); setCurPin(''); setNewPin('') }}>
                <L k="back" />
              </BigButton>
              {pinStep === 'current' ? (
                <BigButton onClick={() => setPinStep('new')} disabled={curPin.length < 4}>
                  <L k="next" sub="text-cream/80" />
                </BigButton>
              ) : (
                <BigButton tone="leaf" onClick={savePin} disabled={newPin.length < 4}>
                  <L k="save" sub="text-white/85" />
                </BigButton>
              )}
            </div>
            <p className="mt-2 text-center text-base text-ink-soft">{t('pinHidden')}</p>
          </div>
        )}
      </Card>

      <BigButton tone="white" className="w-full" onClick={onSignOut}>
        <L k="signOut" />
      </BigButton>
    </div>
  )
}
