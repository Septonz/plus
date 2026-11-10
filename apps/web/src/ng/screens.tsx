// Plus Nigeria screens. Every money action goes prepare -> confirm sheet -> Stellar; reads come
// from the balance cache and the agent-tools read tools (the same tools the voice agent uses).
// Each screen has a loading state (skeletons), an empty state and an error state with a retry.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getMarket } from '@plus/markets'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, PlusData } from '../plus/data'
import {
  applyKey, BigButton, Card, CopyButton, EmptyState, ErrorState, Icon, Keypad, LoadingList, Notice, PinDots, Skeleton, Spinner, SuccessTick, TextField,
} from '../plus/ui'
import { VoiceButton } from '../plus/voice'
import { CodeBox } from './confirm'
import { useTool, type Go, type Wallet } from './NgApp'
import { forScreen, MIC_WORDS, naira, W, when, Y, type WKey } from './words'

type Props = { data: PlusData; wallet: Wallet | null; go: Go; version: number }
type Row = Record<string, unknown>
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const NG = getMarket('ng')

export function Title({ k, go, right }: { k: WKey; go?: Go; right?: ReactNode }) {
  return (
    <header className="flex items-center gap-3 pb-1">
      {go && (
        <button onClick={() => go('home')} aria-label="Back" className="grid size-12 shrink-0 place-items-center rounded-full bg-sand text-2xl font-bold active:bg-sand-deep">
          <Icon name="back" />
        </button>
      )}
      <h1 className="min-w-0 flex-1 text-3xl font-extrabold">
        <Y k={k} />
      </h1>
      {right}
    </header>
  )
}

function Tile({ icon, k, onClick, children }: { icon: string; k: WKey; onClick: () => void; children?: ReactNode }) {
  return (
    <button onClick={onClick} className="flex min-h-36 flex-col items-start gap-2 rounded-card bg-white p-4 text-left shadow-card active:bg-sand">
      <span className="grid size-12 place-items-center rounded-full bg-brick-soft text-3xl text-brick">
        <Icon name={icon} />
      </span>
      <span className="text-xl font-extrabold leading-tight">
        <Y k={k} />
      </span>
      {children && <span className="mt-auto text-base font-semibold text-ink-soft">{children}</span>}
    </button>
  )
}

function Tick({ url, pending }: { url?: string | null; pending?: boolean }) {
  if (pending) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-sand px-3 py-1.5 text-base font-semibold text-ink-soft">
        <Spinner /> Sending
      </span>
    )
  }
  const body = (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-leaf-soft px-3 py-1.5 text-base font-bold text-leaf-deep">
      <Icon name="check" /> Stellar
    </span>
  )
  // A tick is a link to the transaction on Stellar Expert: anyone can check it.
  return url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`${W.verified.en}: open the transaction`} className="shrink-0">{body}</a> : body
}

/** Cash-ins from an agent waiting for her Yes or No. */
function Waiting({ data, onAnswer }: { data: PlusData; onAnswer: (a: PendingAction) => void }) {
  const cashIns = data.pending.filter((a) => a.kind === 'confirm_cash_in')
  if (cashIns.length === 0) return null
  return (
    <div className="space-y-3">
      {cashIns.map((a) => (
        <Card key={a.id} className="border-4 border-saffron">
          <p className="text-base font-bold uppercase tracking-wide text-saffron-deep">
            <Y k="waiting" sub="text-saffron-deep/80" />
          </p>
          <p className="mt-2 text-2xl font-extrabold">{a.readback}</p>
          <BigButton className="mt-3 w-full" onClick={() => onAnswer(a)}>
            <Y k="isThatRight" sub="text-cream/80" />
          </BigButton>
        </Card>
      ))}
    </div>
  )
}

/** A read tool's three states in one place. */
function Loaded({ r, rows = 3, children }: { r: ToolResult | null; rows?: number; children: (r: ToolResult) => ReactNode }) {
  const [retry, setRetry] = useState(0)
  if (!r) return <LoadingList rows={rows} />
  if (r.error === 'network') return <ErrorState key={retry} text="No connection. Your money is safe." onRetry={() => { setRetry((n) => n + 1); window.location.reload() }} />
  return <>{children(r)}</>
}

// ---------------------------------------------------------------------------

export function Home({ data, wallet, go, version, onAnswer }: Props & { onAnswer: (a: PendingAction) => void }) {
  const ajo = useTool('group_status', version)
  const adv = useTool('advance_status', version)
  const rec = useTool('my_record', version)
  const latest = ((rec?.recent ?? []) as Row[]).filter((t) => t.kind !== 'adjustment').slice(0, 3)
  const sending = data.txs.filter((t) => t.status === 'pending').length
  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xl font-bold text-ink-soft">
            <Y k="hello" />
          </p>
          <h1 className="truncate text-4xl font-extrabold">{data.me?.name ?? ''}</h1>
        </div>
        <button onClick={() => go('settings')} aria-label="Settings" className="grid size-12 shrink-0 place-items-center rounded-full bg-sand text-2xl active:bg-sand-deep">
          <Icon name="settings" />
        </button>
      </header>

      <section className="rounded-card bg-brick p-5 text-cream shadow-lift">
        <p className="text-lg font-semibold">
          <Y k="wallet" sub="text-cream/80" />
        </p>
        {wallet ? (
          <p className="mt-1 text-5xl font-extrabold tracking-tight text-turmeric">{naira(wallet.NGNT)}</p>
        ) : (
          <Skeleton className="mt-2 h-12 w-48 opacity-30" />
        )}
        <p className="mt-2 flex items-center gap-2 text-base text-cream/85">
          {sending > 0 ? <><Spinner /> {sending} sending on Stellar…</> : <><Icon name="check" /> Your wallet is on Stellar</>}
          {wallet && wallet.USDC > 0n && <span>· ${(Number(wallet.USDC) / 100).toFixed(2)}</span>}
        </p>
      </section>

      <Waiting data={data} onAnswer={onAnswer} />

      <div className="flex justify-center py-1">
        <VoiceButton words={MIC_WORDS} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Tile icon="add" k="addMoney" onClick={() => go('add_cash')}>Bank or cash</Tile>
        <Tile icon="hand" k="cashOut" onClick={() => go('cash_out')}>Get a code</Tile>
        <Tile icon="group" k="ajo" onClick={() => go('group')}>
          {ajo ? (ajo.in_group ? (ajo.paid_this_period ? 'Paid this round ✓' : ajo.on_its_way ? 'Sending…' : `${String(ajo.amount_text)} due`) : 'Not in one') : <Skeleton className="h-5 w-24" />}
        </Tile>
        <Tile icon="advance" k="advance" onClick={() => go('advance')}>
          {adv ? (adv.open ? `${String(adv.owed_text)} left` : adv.eligible ? `Up to ${String(adv.limit_text)}` : 'Not yet') : <Skeleton className="h-5 w-24" />}
        </Tile>
      </div>

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <h2 className="text-2xl font-extrabold"><Y k="latest" /></h2>
          {latest.length > 0 && <button onClick={() => go('record')} className="min-h-12 px-1 text-lg font-bold text-brick underline">See all</button>}
        </div>
        <Loaded r={rec} rows={2}>
          {() => latest.length > 0 ? (
            <ul className="space-y-2">{latest.map((t) => <TxRow key={String(t.id)} t={t} />)}</ul>
          ) : (
            <EmptyState icon="record" title="Nothing yet">Money in and out shows here, each with its tick on Stellar.</EmptyState>
          )}
        </Loaded>
      </section>
    </div>
  )
}

/** Add money: her own bank account number (simulated partner bank), or cash with an agent. */
export function AddCash({ data, go, version, onAnswer }: Props & { onAnswer: (a: PendingAction) => void }) {
  const bank = useTool('bank_details', version)
  return (
    <div className="space-y-5">
      <Title k="addMoney" go={go} />
      <Waiting data={data} onAnswer={onAnswer} />

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-2xl font-extrabold"><Icon name="bank" className="text-brick" /> <Y k="bankTransfer" /></h2>
        <Loaded r={bank} rows={1}>
          {(b) => b.ok === false ? (
            <Notice>{forScreen(b.text)}</Notice>
          ) : (
            <Card className="space-y-3">
              <p className="text-lg text-ink-soft">Anyone can send you naira from any bank app to:</p>
              <dl className="space-y-2">
                <div>
                  <dt className="text-base font-semibold text-ink-soft">Account number</dt>
                  <dd className="font-mono text-4xl font-extrabold tracking-wider">{String(b.account_number_text)}</dd>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="text-base font-semibold text-ink-soft">Bank</dt>
                    <dd className="text-lg font-bold">{String(b.bank_label)}</dd>
                  </div>
                  <div>
                    <dt className="text-base font-semibold text-ink-soft">Name</dt>
                    <dd className="text-lg font-bold">{String(b.account_name)}</dd>
                  </div>
                </div>
              </dl>
              <CopyButton text={String(b.account_number)} label="Copy account number" />
              <p className="text-base text-ink-soft">It lands in your wallet on Stellar in seconds. If you have an advance, 10% of it pays that back.</p>
            </Card>
          )}
        </Loaded>
        {bank?.ok !== false && bank && <SimulateTransfer data={data} />}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-2xl font-extrabold"><Icon name="hand" className="text-brick" /> <Y k="agentCash" /></h2>
        <Card>
          <ol className="space-y-4 text-lg">
            {[
              <>Give your cash to <b>Mama Bisi</b>, the Plus agent at the market.</>,
              <>She records it with your phone number.</>,
              <>Plus asks you: <b>is that right?</b> Tap Yes. The naira lands in your wallet on Stellar.</>,
            ].map((li, i) => (
              <li key={i} className="flex gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brick text-xl font-extrabold text-cream">{i + 1}</span>
                <span className="pt-1.5">{li}</span>
              </li>
            ))}
          </ol>
        </Card>
      </section>
    </div>
  )
}

/** Demo button: a transfer "arrives" at her account number; the partner's anchor pays her wallet. */
function SimulateTransfer({ data }: { data: PlusData }) {
  const [amount, setAmount] = useState('5000')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [txId, setTxId] = useState<string | null>(null)
  const t0 = useRef(0)
  const [secs, setSecs] = useState<number | null>(null)
  const tx = txId ? data.txs.find((t) => t.id === txId) : undefined
  useEffect(() => {
    if (tx?.status === 'completed' && secs === null) setSecs((Date.now() - t0.current) / 1000)
  }, [tx?.status, secs])

  async function send() {
    setBusy(true)
    setMsg(null)
    setSecs(null)
    t0.current = Date.now()
    const r = await tool('simulate_bank_transfer', { amount, sender: 'Chidi Okeke' }).catch(() => ({ text: 'No connection. Try again.', ok: false }) as ToolResult)
    setBusy(false)
    if (!r.ok) return setMsg(forScreen(r.text))
    setTxId(String(r.transaction_id))
  }

  return (
    <Card className="space-y-3 border-2 border-dashed border-sky/40 bg-sky-soft!">
      <p className="flex items-center gap-2 text-base font-bold uppercase tracking-wide text-sky"><Icon name="star4" /> Demo</p>
      {tx?.status === 'completed' ? (
        <div className="space-y-2 text-center">
          <SuccessTick size="md" />
          <p className="text-xl font-extrabold text-leaf-deep">{naira(BigInt(tx.amount))} arrived{secs !== null && ` in ${secs.toFixed(1)} s`}</p>
          {tx.chain_tx_hash && (
            <a href={`${EXPLORER}/tx/${tx.chain_tx_hash}`} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center gap-1 text-lg font-bold text-brick underline">
              <Icon name="link" /> See it on Stellar Expert
            </a>
          )}
          <button onClick={() => setTxId(null)} className="block min-h-12 w-full text-lg font-bold text-sky underline">Simulate another</button>
        </div>
      ) : txId ? (
        <p className="flex items-center justify-center gap-2 py-3 text-xl font-bold" role="status"><Spinner /> Partner bank is paying your wallet…</p>
      ) : (
        <>
          <p className="text-lg">Pretend someone sent a bank transfer to this account:</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Amount">
            {['2000', '5000', '10000'].map((a) => (
              <button key={a} role="radio" aria-checked={amount === a} onClick={() => setAmount(a)}
                className={`min-h-12 rounded-control border-2 text-lg font-bold ${amount === a ? 'border-sky bg-sky text-white' : 'border-sky/30 bg-white'}`}>
                {naira(BigInt(a) * 100n)}
              </button>
            ))}
          </div>
          {msg && <Notice tone="chili">{msg}</Notice>}
          <BigButton className="w-full bg-sky! text-white!" loading={busy} onClick={() => void send()}>Simulate transfer received</BigButton>
          <p className="text-base text-ink-soft">From “Chidi Okeke”, via Partner bank (simulated).</p>
        </>
      )}
    </Card>
  )
}

function AmountPad({ value, onChange, max = 7 }: { value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <>
      <p className="my-2 text-center text-5xl font-extrabold tracking-tight text-brick" aria-live="polite">
        {naira(BigInt(value || '0') * 100n)}
      </p>
      <Keypad onKey={(k) => onChange(applyKey(value, k, max))} />
    </>
  )
}

function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  async function run(name: string, args: Row) {
    setBusy(true)
    setMsg(null)
    const r = await tool(name, args).catch(() => ({ text: 'No connection. Try again.', ok: false }) as ToolResult)
    setBusy(false)
    if (!r.ok) setMsg(forScreen(r.text))
    return r
  }
  return { busy, msg, run }
}

const localPhone = (e164: string | null | undefined) =>
  e164 && e164.startsWith('+234') ? `0${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}` : e164 ?? ''

/** Pay: a saved person, or anyone by phone number (on Plus: wallet to wallet; not on Plus: a cash code). */
export function Pay({ data, go }: Props) {
  const payees = data.payees
  const [tab, setTab] = useState<'saved' | 'phone'>(payees.length > 0 ? 'saved' : 'phone')
  const [who, setWho] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const { busy, msg, run } = useSubmit()
  const ready = tab === 'saved' ? Boolean(who) : phone.replace(/\D/g, '').length >= 10
  return (
    <div className="space-y-5">
      <Title k="pay" go={go} />
      <div className="grid grid-cols-2 gap-2 rounded-control bg-sand p-1" role="tablist">
        {([['saved', 'savedPeople'], ['phone', 'newNumber']] as const).map(([t, k]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setAmount('') }}
            className={`min-h-14 rounded-xl px-2 text-lg font-bold ${tab === t ? 'bg-white text-brick shadow-card' : 'text-ink-soft'}`}>
            {W[k].en}
          </button>
        ))}
      </div>

      {tab === 'saved' ? (
        payees.length === 0 ? (
          <EmptyState icon="person" title="No saved people yet" action={<button onClick={() => setTab('phone')} className="min-h-12 text-lg font-bold text-brick underline">Pay a phone number</button>}>
            After you pay someone, tap “Save this person”.
          </EmptyState>
        ) : (
          <div className="grid gap-2">
            <p className="text-xl font-bold"><Y k="whoPay" /></p>
            {payees.map((p) => (
              <button key={p.id} onClick={() => setWho(p.name)} aria-pressed={who === p.name}
                className={`flex min-h-16 items-center gap-3 rounded-control px-4 py-2 text-left ${who === p.name ? 'bg-brick text-cream' : 'bg-white shadow-card active:bg-sand'}`}>
                <span className={`grid size-11 shrink-0 place-items-center rounded-full text-2xl ${who === p.name ? 'bg-cream/20' : 'bg-sand text-brick'}`}><Icon name="person" /></span>
                <span className="min-w-0">
                  <span className="block truncate text-xl font-bold">{p.name}</span>
                  {p.phone && <span className={`block text-base ${who === p.name ? 'text-cream/80' : 'text-ink-soft'}`}>{localPhone(p.phone)}</span>}
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <Card className="space-y-4">
          <TextField label="Their phone number" value={phone} onChange={setPhone} inputMode="tel" placeholder="0803 555 0101" autoComplete="off" />
          <TextField label="Their name (for your record)" value={name} onChange={setName} placeholder="Mama Ngozi" maxLength={40} />
          <p className="flex gap-2 text-base text-ink-soft">
            <Icon name="info" className="mt-0.5 text-lg text-sky" />
            <span>On Plus? It goes straight to their wallet. Not on Plus? They get a text with a code and collect cash at any Plus agent.</span>
          </p>
        </Card>
      )}

      {ready && (
        <Card>
          <p className="text-xl font-bold"><Y k="howMuch" /></p>
          <AmountPad value={amount} onChange={setAmount} />
          {msg && <div className="mt-3"><Notice tone="chili">{msg}</Notice></div>}
          <BigButton className="mt-4 w-full" loading={busy} disabled={!amount} onClick={async () => {
            const r = await run('prepare_pay', tab === 'saved' ? { payee: who, amount } : { phone, name: name.trim() || undefined, amount })
            if (r.ok) setAmount('')
          }}>
            <Y k="next" sub="text-cream/80" />
          </BigButton>
        </Card>
      )}
    </div>
  )
}

export function Ajo({ go, version }: Props) {
  const g = useTool('group_status', version)
  const { busy, msg, run } = useSubmit()
  return (
    <div className="space-y-5">
      <Title k="ajo" go={go} />
      <Loaded r={g} rows={5}>
        {(g) => !g.in_group ? (
          <EmptyState icon="group" title="Not in an ajo yet">{forScreen(g.text)}</EmptyState>
        ) : (
          <AjoBody g={g} busy={busy} msg={msg} pay={() => void run('prepare_ajo_contribution', {})} />
        )}
      </Loaded>
    </div>
  )
}

function AjoBody({ g, busy, msg, pay }: { g: ToolResult; busy: boolean; msg: string | null; pay: () => void }) {
  const members = (g.members ?? []) as Row[]
  const paid = members.filter((m) => m.paid_this_round).length
  return (
    <>
      <Card className="space-y-3">
        <h2 className="text-2xl font-extrabold">{String(g.name)}</h2>
        <p className="text-lg text-ink-soft">{String(g.amount_text)} each, every {Number(g.period_days) === 1 ? 'day' : `${String(g.period_days)} days`}</p>
        <div>
          <div className="flex justify-between text-base font-bold"><span>{paid} of {members.length} paid</span><span>this round</span></div>
          <div className="mt-1 h-3 overflow-hidden rounded-full bg-sand" aria-hidden="true">
            <div className="h-full rounded-full bg-leaf transition-all" style={{ width: `${members.length ? (paid / members.length) * 100 : 0}%` }} />
          </div>
        </div>
        <p className="text-lg">
          This round's pot goes to <b>{members.find((m) => m.is_turn)?.is_me ? 'you' : String(g.turn_name)}</b> on{' '}
          {new Date(String(g.next_due)).toLocaleString('en-NG', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.
        </p>
        {!g.paid_this_period && !g.on_its_way && (
          <BigButton className="w-full" loading={busy} onClick={pay}>
            <Y k="payMyPart" sub="text-cream/80" /> {String(g.amount_text)}
          </BigButton>
        )}
        {msg && <Notice tone="chili">{msg}</Notice>}
      </Card>
      <h2 className="text-2xl font-extrabold"><Y k="members" /></h2>
      <ul className="space-y-2">
        {members.map((m) => (
          <li key={String(m.position)} className={`flex items-center justify-between gap-2 rounded-control p-4 ${m.is_me ? 'bg-sand' : 'bg-white'} shadow-card`}>
            <div className="min-w-0">
              <p className="truncate text-xl font-bold">
                {String(m.name)} {m.is_me ? '(you)' : ''} {m.is_turn ? '★' : ''}
              </p>
              {Boolean(m.is_turn) && <p className="text-base text-ink-soft">Collects this round</p>}
            </div>
            {m.paid_this_round ? <Tick url={(m.url as string | null) ?? (g.contract_url as string | null)} /> : m.is_me && g.on_its_way ? <Tick pending /> : <span className="shrink-0 text-base font-semibold text-ink-soft">{W.notYet.en}</span>}
          </li>
        ))}
      </ul>
      <p className="text-base text-ink-soft">The ticks are read from the Plus contract on Stellar, not from our database.</p>
    </>
  )
}

/** The four promises, said the same way on every advance screen (and by the voice agent). */
function AdvanceRules({ fee, pct }: { fee: string | null; pct: number }) {
  const rules: [WKey, string][] = [
    ['oneFee', fee ? `${W.oneFee.en}: ${fee}` : W.oneFee.en],
    ['noInterest', W.noInterest.en],
    ['noLateFees', W.noLateFees.en],
    ['repaysItself', `${W.repaysItself.en}: ${pct}% of each cash-in`],
  ]
  return (
    <ul className="mt-3 space-y-2 text-lg">
      {rules.map(([k, en]) => (
        <li key={k} className="flex gap-2">
          <Icon name="check" className="mt-1 text-leaf" />
          <span className="flex flex-col leading-tight">
            <span className="font-semibold">{en}</span>
            <span className="text-base text-ink-soft">{W[k].yo}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function IfBehind() {
  return (
    <Notice>
      <span className="flex flex-col gap-1">
        <span className="font-semibold">{W.ifBehind.en} {W.nobodyCalled.en}</span>
        <span className="text-base font-normal text-ink-soft">{W.ifBehind.yo} {W.nobodyCalled.yo}</span>
      </span>
    </Notice>
  )
}

export function Advance({ go, version }: Props) {
  const a = useTool('advance_status', version)
  const { busy, msg, run } = useSubmit()
  const pct = Number(a?.repay_pct ?? NG.advance.repayFromCashInBps / 100)
  return (
    <div className="space-y-5">
      <Title k="advance" go={go} />
      <Loaded r={a} rows={2}>
        {(a) => {
          const options = (a.options ?? []) as Row[]
          const top = options.at(-1)
          return a.open ? (
            <Card>
              <p className="text-lg font-semibold">Still to pay back</p>
              <p className="text-5xl font-extrabold text-brick">{String(a.owed_text)}</p>
              <p className="mt-2 text-lg">You took {String(a.principal_text)}. Paid back so far: {String(a.repaid_text)}.</p>
              <AdvanceRules fee={a.fee_text ? String(a.fee_text) : null} pct={pct} />
              <p className="mt-3 text-lg">It also comes first out of your next ajo payout.</p>
            </Card>
          ) : a.eligible ? (
            <>
              <Card>
                <p className="text-lg font-semibold">You can take up to</p>
                <p className="text-5xl font-extrabold text-brick">{String(a.limit_text)}</p>
                <AdvanceRules fee={top ? `${String(top.fee_text)} on ${String(top.amount_text)}` : null} pct={pct} />
              </Card>
              <p className="text-xl font-bold"><Y k="takeAdvance" /></p>
              <div className="grid gap-3">
                {options.map((o) => (
                  <BigButton key={String(o.amount_minor)} tone="white" disabled={busy} className="justify-between! text-left" onClick={() => void run('prepare_advance', { amount: String(BigInt(String(o.amount_minor)) / 100n) })}>
                    <span className="text-2xl">{String(o.amount_text)}</span>
                    <span className="text-lg font-semibold text-ink-soft">fee {String(o.fee_text)}</span>
                  </BigButton>
                ))}
              </div>
            </>
          ) : (
            <EmptyState icon="advance" title="Not yet">{forScreen(a.text)}</EmptyState>
          )
        }}
      </Loaded>
      <IfBehind />
      {msg && <Notice tone="chili">{msg}</Notice>}
    </div>
  )
}

export function CashOut({ go, version }: Props) {
  const list = useTool('cash_outs', version)
  const [amount, setAmount] = useState('')
  const [shown, setShown] = useState<{ id: string; code: string } | null>(null)
  const { busy, msg, run } = useSubmit()
  const open = ((list?.cash_outs ?? []) as Row[]).filter((c) => c.status === 'issued' && new Date(String(c.expires_at)) > new Date())
  return (
    <div className="space-y-5">
      <Title k="cashOut" go={go} />
      {open.map((c) => (
        <Card key={String(c.id)} className="space-y-2">
          <p className="text-2xl font-extrabold">{String(c.amount_text)} waiting for an agent</p>
          <p className="text-base text-ink-soft">Unused until {new Date(String(c.expires_at)).toLocaleDateString('en-NG')}, then it comes back to your wallet.</p>
          {shown && shown.id === c.id ? (
            <CodeBox code={shown.code} />
          ) : (
            <BigButton tone="white" className="w-full" loading={busy} onClick={async () => {
              const r = await run('new_cashout_code', { cash_out_id: c.id })
              if (r.ok) setShown({ id: String(c.id), code: String(r.cash_out_code) })
            }}>
              <Y k="newCode" />
            </BigButton>
          )}
        </Card>
      ))}
      <Card>
        <p className="text-xl font-bold">How much cash do you need?</p>
        <AmountPad value={amount} onChange={setAmount} max={6} />
        {msg && <div className="mt-3"><Notice tone="chili">{msg}</Notice></div>}
        <BigButton className="mt-4 w-full" loading={busy} disabled={!amount} onClick={async () => {
          const r = await run('prepare_cashout', { amount })
          if (r.ok) setAmount('')
        }}>
          <Y k="next" sub="text-cream/80" />
        </BigButton>
      </Card>
      <p className="text-base text-ink-soft">The money waits on Stellar for a registered agent. Only someone with your code gets it; after {NG.cashOutCode?.returnAfterDays ?? 7} days it comes back to you.</p>
    </div>
  )
}

const KIND_ICON: Record<string, string> = { incoming: 'add', pay: 'pay', group_contribution: 'group', advance: 'advance', repay: 'advance', cash_out: 'hand' }

/** One transaction with its "verified on Stellar" tick, which links to the transaction. */
function TxRow({ t }: { t: Row }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-control bg-white p-4 shadow-card">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`grid size-11 shrink-0 place-items-center rounded-full text-2xl ${t.outgoing ? 'bg-sand text-brick' : 'bg-leaf-soft text-leaf'}`}>
          <Icon name={KIND_ICON[String(t.kind)] ?? 'record'} />
        </span>
        <div className="min-w-0">
          <p className="text-xl font-bold">{t.outgoing ? '−' : '+'}{String(t.amount_text)}</p>
          <p className="truncate text-base text-ink-soft">{String(t.label)} · {when(String(t.at))}</p>
        </div>
      </div>
      {t.status === 'pending' ? <Tick pending /> : t.url ? <Tick url={String(t.url)} /> : null}
    </li>
  )
}

export function Record({ go, version }: Props) {
  const r = useTool('my_record', version)
  return (
    <div className="space-y-5">
      <Title k="record" go={go} />
      <Loaded r={r} rows={4}>
        {(r) => {
          const totals = (r.totals ?? {}) as Row
          const recent = (r.recent ?? []) as Row[]
          return (
            <>
              <Card>
                <dl className="grid grid-cols-2 gap-4">
                  {([['Came in', totals.received_text], ['Paid', totals.paid_text], ['Into ajo', totals.ajo_text], ['Agent cash-ins', r.cash_ins]] as const).map(([k, v]) => (
                    <div key={k}><dt className="text-base text-ink-soft">{k}</dt><dd className="text-2xl font-extrabold">{String(v ?? '—')}</dd></div>
                  ))}
                </dl>
                <p className="mt-3 text-base text-ink-soft">{String(r.confirmed_on_stellar)} transactions, each checkable on Stellar. Your name is not on the chain.</p>
                {typeof r.account_url === 'string' && (
                  <a href={r.account_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-12 items-center gap-1 text-lg font-bold text-brick underline">
                    <Icon name="link" /> Your wallet on Stellar Expert
                  </a>
                )}
              </Card>
              {recent.length > 0 ? (
                <ul className="space-y-2">{recent.map((t) => <TxRow key={String(t.id)} t={t} />)}</ul>
              ) : (
                <EmptyState icon="record" title="Nothing yet">Add money by bank transfer or with an agent, and it shows here.</EmptyState>
              )}
            </>
          )
        }}
      </Loaded>
    </div>
  )
}

export function Settings({ go, version, onSignOut }: Props & { onSignOut: () => void }) {
  const me = useTool('get_user', version)
  const [pin, setPin] = useState('')
  const { busy, msg, run } = useSubmit()
  const [saved, setSaved] = useState(false)
  const limits = (me?.limits ?? null) as { tier: number; daily_text: string; balance_text: string; advances: boolean } | null
  return (
    <div className="space-y-5">
      <Title k="settings" go={go} />
      <Loaded r={me} rows={1}>
        {() => limits && (
          <Card className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xl font-bold"><Icon name="shield" className="text-brick" /> Level {limits.tier}</p>
              <span className="rounded-full bg-leaf-soft px-3 py-1 text-base font-bold text-leaf-deep">{limits.tier >= 2 ? 'NIN checked' : 'Photo checked'}</span>
            </div>
            <p className="text-lg">Send up to <b>{limits.daily_text}</b> a day · hold up to <b>{limits.balance_text}</b></p>
            {me?.virtual_account ? <p className="text-base text-ink-soft">Bank transfers in: {String(me.virtual_account)} · {String(me.bank_label)}</p> : null}
          </Card>
        )}
      </Loaded>
      <Card>
        <p className="text-xl font-bold"><Icon name="lock" /> PIN</p>
        <p className="text-base text-ink-soft">Needed on this screen for payments over {naira(BigInt(NG.pinThreshold) * 100n)}. Never say it out loud.</p>
        <PinDots length={pin.length} />
        <Keypad onKey={(k) => setPin((p) => applyKey(p, k, 6, true))} />
        {msg && <div className="mt-3"><Notice tone="chili">{msg}</Notice></div>}
        {saved && <div className="mt-3"><Notice tone="leaf">PIN saved.</Notice></div>}
        <BigButton className="mt-3 w-full" loading={busy} disabled={pin.length < 4} onClick={async () => {
          const r = await run('set_pin', { pin })
          setPin('')
          setSaved(Boolean(r.ok))
        }}>Save PIN</BigButton>
      </Card>
      <BigButton tone="white" className="w-full" onClick={onSignOut}><Y k="signOut" /></BigButton>
      <p className="text-center text-base text-ink-soft">
        <a className="underline" href={EXPLORER} target="_blank" rel="noreferrer">Stellar testnet</a> · demo only
      </p>
    </div>
  )
}
