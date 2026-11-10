// Plus Nigeria screens. Every money action goes prepare -> confirm sheet -> Stellar; reads come
// from the balance cache and the agent-tools read tools (the same tools the voice agent uses).
import { useState, type ReactNode } from 'react'
import { getMarket } from '@plus/markets'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, PlusData } from '../plus/data'
import { applyKey, BigButton, Card, Icon, Keypad, Notice, PinDots } from '../plus/ui'
import { VoiceButton } from '../plus/voice'
import { CodeBox } from './confirm'
import { useTool, type Go, type Wallet } from './NgApp'
import { MIC_WORDS, naira, W, when, Y, type WKey } from './words'

type Props = { data: PlusData; wallet: Wallet | null; go: Go; version: number }
type Row = Record<string, unknown>
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const NG = getMarket('ng')

function Title({ k, go }: { k: WKey; go?: Go }) {
  return (
    <header className="flex items-center gap-3 pb-4">
      {go && (
        <button onClick={() => go('home')} aria-label="Back" className="grid size-12 place-items-center rounded-full bg-sand text-2xl font-bold">
          <Icon name="back" />
        </button>
      )}
      <h1 className="text-3xl font-extrabold">
        <Y k={k} />
      </h1>
    </header>
  )
}

function Tile({ icon, k, onClick, children }: { icon: string; k: WKey; onClick: () => void; children?: ReactNode }) {
  return (
    <button onClick={onClick} className="flex min-h-32 flex-col items-start justify-between rounded-3xl bg-white p-4 text-left shadow-[0_2px_0_0_var(--color-sand-deep)] active:bg-sand">
      <Icon name={icon} className="text-4xl text-brick" />
      <span className="text-xl font-extrabold">
        <Y k={k} />
      </span>
      {children && <span className="text-base text-ink-soft">{children}</span>}
    </button>
  )
}

function Tick({ url, pending }: { url?: string | null; pending?: boolean }) {
  if (pending) return <span className="inline-flex items-center gap-1 rounded-full bg-sand px-3 py-1 text-base font-semibold text-ink-soft">⏳ <Y k="sending" sub="hidden" /></span>
  const body = (
    <span className="inline-flex items-center gap-1 rounded-2xl bg-leaf-soft px-3 py-1 text-base font-semibold text-leaf">
      <Icon name="check" /> <Y k="verified" className="text-sm leading-tight" sub="text-leaf/80 text-xs" />
    </span>
  )
  // A tick is a link to the transaction on Stellar Expert: anyone can check it.
  return url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`${W.verified.en}: open the transaction`}>{body}</a> : body
}

/** Cash-ins from an agent waiting for her Yes or No. */
function Waiting({ data, onAnswer }: { data: PlusData; onAnswer: (a: PendingAction) => void }) {
  const cashIns = data.pending.filter((a) => a.kind === 'confirm_cash_in')
  if (cashIns.length === 0) return null
  return (
    <div className="space-y-3">
      {cashIns.map((a) => (
        <Card key={a.id} className="border-4 border-saffron">
          <p className="text-base font-bold uppercase tracking-wide text-saffron">
            <Y k="waiting" sub="text-saffron/80" />
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

// ---------------------------------------------------------------------------

export function Home({ data, wallet, go, version, onAnswer }: Props & { onAnswer: (a: PendingAction) => void }) {
  const ajo = useTool('group_status', version)
  const adv = useTool('advance_status', version)
  const rec = useTool('my_record', version)
  const latest = ((rec?.recent ?? []) as Row[]).filter((t) => t.kind !== 'adjustment').slice(0, 3)
  const sending = data.txs.filter((t) => t.status === 'pending').length
  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-xl font-bold text-ink-soft">
            <Y k="hello" />
          </p>
          <h1 className="text-4xl font-extrabold">{data.me?.name ?? ''}</h1>
        </div>
        <button onClick={() => go('settings')} aria-label="Settings" className="grid size-12 place-items-center rounded-full bg-sand text-2xl">
          <Icon name="settings" />
        </button>
      </header>

      <Card className="bg-brick! text-cream">
        <p className="text-lg font-semibold">
          <Y k="wallet" sub="text-cream/80" />
        </p>
        <p className="mt-1 text-5xl font-extrabold text-turmeric">{wallet ? naira(wallet.NGNT) : '…'}</p>
        <p className="mt-2 text-base text-cream/80">
          {sending > 0 ? `${sending} sending on Stellar…` : 'Your wallet is on Stellar'}
          {wallet && wallet.USDC > 0n && ` · $${(Number(wallet.USDC) / 100).toFixed(2)}`}
        </p>
      </Card>

      <Waiting data={data} onAnswer={onAnswer} />

      <div className="flex justify-center py-2">
        <VoiceButton words={MIC_WORDS} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Tile icon="add" k="addCash" onClick={() => go('add_cash')}>From Mama Bisi</Tile>
        <Tile icon="hand" k="cashOut" onClick={() => go('cash_out')}>Get a code</Tile>
        <Tile icon="group" k="ajo" onClick={() => go('group')}>
          {ajo?.in_group ? (ajo.paid_this_period ? 'Paid this round ✓' : ajo.on_its_way ? 'Sending…' : `${String(ajo.amount_text)} due`) : '…'}
        </Tile>
        <Tile icon="advance" k="advance" onClick={() => go('advance')}>
          {adv ? (adv.open ? `${String(adv.owed_text)} left` : adv.eligible ? `Up to ${String(adv.limit_text)}` : 'Not yet') : '…'}
        </Tile>
      </div>

      {latest.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-2xl font-extrabold"><Y k="latest" /></h2>
          <ul className="space-y-2">
            {latest.map((t) => <TxRow key={String(t.id)} t={t} />)}
          </ul>
          <button onClick={() => go('record')} className="min-h-11 text-lg font-bold text-brick underline">See all · {W.record.en}</button>
        </section>
      )}
    </div>
  )
}

export function AddCash({ data, go, onAnswer }: Props & { onAnswer: (a: PendingAction) => void }) {
  return (
    <div className="space-y-5">
      <Title k="addCash" go={go} />
      <Waiting data={data} onAnswer={onAnswer} />
      <Card>
        <ol className="space-y-4 text-xl">
          <li className="flex gap-3"><span className="text-3xl">1</span><span>Give your cash to <b>Mama Bisi</b>, the Plus agent at the market.</span></li>
          <li className="flex gap-3"><span className="text-3xl">2</span><span>She records it with your phone number.</span></li>
          <li className="flex gap-3"><span className="text-3xl">3</span><span>Plus asks you: <b>is that right?</b> Tap Yes. The naira lands in your wallet on Stellar.</span></li>
        </ol>
      </Card>
      <Notice>If you have an advance, 10% of each cash-in pays it back by itself.</Notice>
    </div>
  )
}

function AmountPad({ value, onChange, max = 7 }: { value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <>
      <p className="my-4 text-center text-5xl font-extrabold text-brick" aria-live="polite">
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
    if (!r.ok) setMsg(r.text)
    return r
  }
  return { busy, msg, run }
}

export function Pay({ data, go }: Props) {
  const payees = data.payees as unknown as { id: string; name: string }[]
  const [who, setWho] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const { busy, msg, run } = useSubmit()
  return (
    <div className="space-y-5">
      <Title k="pay" go={go} />
      <p className="text-xl font-bold">
        <Y k="whoPay" />
      </p>
      <div className="grid gap-3">
        {payees.map((p) => (
          <button key={p.id} onClick={() => setWho(p.name)} className={`flex min-h-20 items-center gap-3 rounded-2xl px-4 text-left text-xl font-bold ${who === p.name ? 'bg-brick text-cream' : 'bg-white shadow-[0_2px_0_0_var(--color-sand-deep)]'}`}>
            <Icon name="person" className="text-3xl" /> {p.name}
          </button>
        ))}
      </div>
      {who && (
        <>
          <p className="text-xl font-bold"><Y k="howMuch" /></p>
          <AmountPad value={amount} onChange={setAmount} />
          {msg && <Notice tone="chili">{msg}</Notice>}
          <BigButton className="w-full" disabled={!amount || busy} onClick={async () => {
            const r = await run('prepare_pay', { payee: who, amount })
            if (r.ok) setAmount('')
          }}>
            <Y k="next" sub="text-cream/80" />
          </BigButton>
        </>
      )}
    </div>
  )
}

export function Ajo({ go, version }: Props) {
  const g = useTool('group_status', version)
  const { busy, msg, run } = useSubmit()
  if (!g) return <p className="py-20 text-center text-2xl">…</p>
  if (!g.in_group) return <div className="space-y-5"><Title k="ajo" go={go} /><Notice>{g.text}</Notice></div>
  const members = (g.members ?? []) as Row[]
  return (
    <div className="space-y-5">
      <Title k="ajo" go={go} />
      <Card>
        <h2 className="text-2xl font-extrabold">{String(g.name)}</h2>
        <p className="mt-1 text-lg text-ink-soft">{String(g.amount_text)} each, every {Number(g.period_days) === 1 ? 'day' : `${String(g.period_days)} days`}</p>
        <p className="mt-3 text-xl">
          This round's pot goes to <b>{members.find((m) => m.is_turn)?.is_me ? 'you' : String(g.turn_name)}</b> on{' '}
          {new Date(String(g.next_due)).toLocaleString('en-NG', { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.
        </p>
        {!g.paid_this_period && !g.on_its_way && (
          <BigButton className="mt-4 w-full" disabled={busy} onClick={() => void run('prepare_ajo_contribution', {})}>
            <Y k="payMyPart" sub="text-cream/80" /> {String(g.amount_text)}
          </BigButton>
        )}
        {msg && <div className="mt-3"><Notice tone="chili">{msg}</Notice></div>}
      </Card>
      <h2 className="text-2xl font-extrabold"><Y k="members" /></h2>
      <ul className="space-y-2">
        {members.map((m) => (
          <li key={String(m.position)} className={`flex items-center justify-between gap-2 rounded-2xl p-4 ${m.is_me ? 'bg-sand' : 'bg-white'} shadow-[0_2px_0_0_var(--color-sand-deep)]`}>
            <div>
              <p className="text-xl font-bold">
                {String(m.name)} {m.is_me ? '(you)' : ''} {m.is_turn ? '★' : ''}
              </p>
              <p className="text-base text-ink-soft">{m.is_turn ? 'Collects this round' : ''}</p>
            </div>
            {m.paid_this_round ? <Tick url={(m.url as string | null) ?? (g.contract_url as string | null)} /> : m.is_me && g.on_its_way ? <Tick pending /> : <span className="text-base font-semibold text-ink-soft"><Y k="notYet" /></span>}
          </li>
        ))}
      </ul>
      <p className="text-base text-ink-soft">The ticks are read from the Plus contract on Stellar, not from our database.</p>
    </div>
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
    <ul className="mt-3 space-y-2 text-xl">
      {rules.map(([k, en]) => (
        <li key={k} className="flex gap-2">
          <span className="text-leaf">✓</span>
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
        <span className="text-base text-ink-soft">{W.ifBehind.yo} {W.nobodyCalled.yo}</span>
      </span>
    </Notice>
  )
}

export function Advance({ go, version }: Props) {
  const a = useTool('advance_status', version)
  const { busy, msg, run } = useSubmit()
  if (!a) return <p className="py-20 text-center text-2xl">…</p>
  const options = (a.options ?? []) as Row[]
  const pct = Number(a.repay_pct ?? NG.advance.repayFromCashInBps / 100)
  const top = options.at(-1)
  return (
    <div className="space-y-5">
      <Title k="advance" go={go} />
      {a.open ? (
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
              <BigButton key={String(o.amount_minor)} tone="white" disabled={busy} className="flex items-center justify-between text-left" onClick={() => void run('prepare_advance', { amount: String(BigInt(String(o.amount_minor)) / 100n) })}>
                <span className="text-2xl">{String(o.amount_text)}</span>
                <span className="text-lg font-semibold text-ink-soft">fee {String(o.fee_text)}</span>
              </BigButton>
            ))}
          </div>
        </>
      ) : (
        <Notice>{a.text}</Notice>
      )}
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
        <Card key={String(c.id)}>
          <p className="text-2xl font-extrabold">{String(c.amount_text)} waiting for an agent</p>
          <p className="text-base text-ink-soft">Unused until {new Date(String(c.expires_at)).toLocaleDateString('en-NG')}, then it comes back to your wallet.</p>
          {shown && shown.id === c.id ? (
            <div className="mt-3"><CodeBox code={shown.code} /></div>
          ) : (
            <BigButton tone="white" className="mt-3 w-full" disabled={busy} onClick={async () => {
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
        <BigButton className="mt-4 w-full" disabled={!amount || busy} onClick={async () => {
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
    <li className="flex items-center justify-between gap-2 rounded-2xl bg-white p-4 shadow-[0_2px_0_0_var(--color-sand-deep)]">
      <div className="flex items-center gap-3">
        <Icon name={KIND_ICON[String(t.kind)] ?? 'record'} className="text-3xl text-brick" />
        <div>
          <p className="text-xl font-bold">{t.outgoing ? '−' : '+'}{String(t.amount_text)} <span className="text-base font-normal text-ink-soft">{String(t.label)}</span></p>
          <p className="text-base text-ink-soft">{when(String(t.at))}</p>
        </div>
      </div>
      {t.status === 'pending' ? <Tick pending /> : t.url ? <Tick url={String(t.url)} /> : null}
    </li>
  )
}

export function Record({ go, version }: Props) {
  const r = useTool('my_record', version)
  if (!r) return <p className="py-20 text-center text-2xl">…</p>
  const totals = (r.totals ?? {}) as Row
  const recent = (r.recent ?? []) as Row[]
  return (
    <div className="space-y-5">
      <Title k="record" go={go} />
      <Card>
        <dl className="grid grid-cols-2 gap-3 text-lg">
          <div><dt className="text-ink-soft">Came in</dt><dd className="text-2xl font-extrabold">{String(totals.received_text)}</dd></div>
          <div><dt className="text-ink-soft">Paid</dt><dd className="text-2xl font-extrabold">{String(totals.paid_text)}</dd></div>
          <div><dt className="text-ink-soft">Into ajo</dt><dd className="text-2xl font-extrabold">{String(totals.ajo_text)}</dd></div>
          <div><dt className="text-ink-soft">Cash-ins with an agent</dt><dd className="text-2xl font-extrabold">{String(r.cash_ins)}</dd></div>
        </dl>
        <p className="mt-3 text-base text-ink-soft">{String(r.confirmed_on_stellar)} transactions, each checkable on Stellar. Your name is not on the chain.</p>
        {typeof r.account_url === 'string' && (
          <a href={r.account_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-lg font-bold text-brick underline">
            <Icon name="link" /> Your wallet on Stellar Expert
          </a>
        )}
      </Card>
      <ul className="space-y-2">
        {recent.map((t) => <TxRow key={String(t.id)} t={t} />)}
      </ul>
    </div>
  )
}

export function Settings({ go, onSignOut }: Props & { onSignOut: () => void }) {
  const [pin, setPin] = useState('')
  const { busy, msg, run } = useSubmit()
  const [saved, setSaved] = useState(false)
  return (
    <div className="space-y-5">
      <Title k="settings" go={go} />
      <Card>
        <p className="text-xl font-bold"><Icon name="lock" /> PIN</p>
        <p className="text-base text-ink-soft">Needed on this screen for payments over {naira(BigInt(NG.pinThreshold) * 100n)}. Never say it out loud.</p>
        <PinDots length={pin.length} />
        <Keypad onKey={(k) => setPin((p) => applyKey(p, k, 6, true))} />
        {msg && <div className="mt-3"><Notice tone="chili">{msg}</Notice></div>}
        {saved && <div className="mt-3"><Notice tone="leaf">PIN saved.</Notice></div>}
        <BigButton className="mt-3 w-full" disabled={pin.length < 4 || busy} onClick={async () => {
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
