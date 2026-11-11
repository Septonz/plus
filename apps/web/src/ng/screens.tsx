// Plus Nigeria screens. Every money action goes prepare -> confirm sheet -> Stellar; reads come
// from the balance cache and the agent-tools read tools (the same tools the voice agent uses).
// Each screen has a loading state (skeletons), an empty state and an error state with a retry.
// Home is a stack of passes (Wallet, Ajo, Loan); a pass opens full-screen (NgApp's CardDetail).
import { formatTime } from '../lib/time'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getMarket } from '@plus/markets'
import {
  AmountDisplay, Bilingual, Button, Card, CardStack, EmptyState, Icon, ListGroup, ListRow, Notice, NumPad, Pass,
  PinPad, Section, Segmented, Skeleton, Spinner, Tick, VerifiedMark, applyKey,
} from '../ds/components'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, PlusData } from '../plus/data'
import { useSays } from '../plus/screen'
import { CopyButton, ErrorState, LoadingList, TextField } from '../plus/ui'
import { WitnessRequests } from './assets'
import { StellarDetails } from './shop'
import { CodeBox } from './confirm'
import { useTool, type Go, type Wallet } from './NgApp'
import { forScreen, naira, W, when, yo } from './words'

type Props = { data: PlusData; wallet: Wallet | null; go: Go; version: number }
type Row = Record<string, unknown>
const EXPLORER = 'https://stellar.expert/explorer/testnet'
const NG = getMarket('ng')

/** A read tool's three states in one place. */
function Loaded({ r, rows = 3, children }: { r: ToolResult | null; rows?: number; children: (r: ToolResult) => ReactNode }) {
  if (!r) return <LoadingList rows={rows} />
  if (r.error === 'network') return <ErrorState text="No connection. Your money is safe." onRetry={() => window.location.reload()} />
  return <>{children(r)}</>
}

/** Cash-ins from an agent waiting for her Yes or No. */
function Waiting({ data, onAnswer }: { data: PlusData; onAnswer: (a: PendingAction) => void }) {
  const cashIns = data.pending.filter((a) => a.kind === 'confirm_cash_in')
  if (cashIns.length === 0) return null
  return (
    <div className="space-y-3">
      {cashIns.map((a) => (
        <Card key={a.id} className="border border-warning/30 bg-warning-soft!">
          <p className="flex items-center gap-2 text-sm font-medium text-warning-strong">
            <Icon name="cash" /> <Bilingual main={W.waiting.en} sub={yo('waiting')} subClass="text-warning-strong/80" />
          </p>
          <p className="mt-2 text-xl font-medium">{a.readback}</p>
          <Button className="mt-4 w-full" onClick={() => onAnswer(a)}>{W.isThatRight.en}</Button>
        </Card>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------- Home

export type Detail = 'wallet' | 'savings' | 'group' | 'loan' | 'assets' | 'add_cash' | 'cash_out' | 'receive' | 'scan'

export function Home({ data, wallet, go, version, onAnswer, open, onOpen }: Props & { onAnswer: (a: PendingAction) => void; open: Detail | null; onOpen: (d: Detail) => void }) {
  const ajo = useTool('group_status', version)
  const sav = useTool('savings_status', version)
  const loan = useTool('loan_status', version)
  const assets = useTool('my_assets', version)
  const owned = ((assets?.assets ?? []) as Row[]).filter((a) => a.status !== 'released')
  const verified = owned.filter((a) => a.status === 'active' && a.level !== 'registered').length
  const rec = useTool('my_record', version)
  const latest = ((rec?.recent ?? []) as Row[]).filter((t) => t.kind !== 'adjustment').slice(0, 5)
  const sending = data.txs.filter((t) => t.status === 'pending').length
  const name = data.me?.name ?? ''
  const members = (ajo?.members ?? []) as Row[]
  const paid = members.filter((m) => m.paid_this_round).length
  const cashIns = data.pending.filter((a) => a.kind === 'confirm_cash_in')
  useSays(
    `Home. Wallet: ${wallet ? naira(wallet.NGNT) : 'loading'}${sending ? `, ${sending} sending` : ''}. ` +
      (ajo ? (ajo.in_group ? `Ajo ${String(ajo.name)}: ${paid} of ${members.length} paid this round; her part ${ajo.paid_this_period ? 'is paid' : ajo.on_its_way ? 'is sending' : `is not paid (${String(ajo.amount_text)})`}. ` : 'Not in an ajo. ') : '') +
      (sav?.has_goal ? `Savings: ${String(sav.saved_text)} of ${String(sav.goal_text)} for ${String(sav.goal_name)}. ` : '') +
      (loan?.ok ? `Loan: ${loanLine(loan)}. ` : '') +
      (cashIns.length ? `Waiting for her answer: ${cashIns.map((a) => a.readback).join('; ')}. ` : '') +
      (latest.length ? `Latest: ${latest.slice(0, 3).map((t) => `${String(t.label)} ${t.outgoing ? '-' : '+'}${String(t.amount_text)}`).join(', ')}. ` : '') +
      (assets?.ok ? `Assets: ${owned.length} registered, ${verified} verified. ` : '') +
      'Cards: Wallet, Savings, Ajo, Loan, Assets. Tabs: Home, Pay, Activity, Profile.',
  )

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between gap-3 pt-1">
        <div className="min-w-0">
          <p className="text-base text-secondary">{W.hello.en}</p>
          <h1 className="truncate text-3xl font-semibold">{name}</h1>
        </div>
        <button onClick={() => go('settings')} aria-label="Profile" className="grid size-11 shrink-0 place-items-center rounded-full bg-fill text-base font-semibold text-label active:bg-fill-strong">
          {name.slice(0, 1).toUpperCase() || <Icon name="profile" />}
        </button>
      </header>

      <Waiting data={data} onAnswer={onAnswer} />
      <WitnessRequests version={version} compact />

      <CardStack>
        <Pass
          id="wallet"
          tone="wallet"
          icon="wallet"
          title={W.wallet.en}
          hidden={open === 'wallet'}
          onOpen={() => onOpen('wallet')}
          note={sending > 0 ? `${sending} sending…` : 'Add money · Cash out'}
        >
          {wallet ? <AmountDisplay text={naira(wallet.NGNT)} size="lg" /> : <Skeleton className="h-12 w-48 opacity-30" />}
        </Pass>
        <Pass
          id="savings"
          icon="savings"
          title={W.savings.en}
          sub={sav ? (sav.has_goal ? `${W.goal.en}: ${String(sav.goal_name)} ${String(sav.goal_text)}` : 'Set a goal') : ' '}
          value={sav?.has_goal ? String(sav.saved_text) : undefined}
          hidden={open === 'savings'}
          onOpen={() => onOpen('savings')}
        >
          {sav?.has_goal ? <Progress pct={savedPct(sav)} label={`${String(sav.left_text)} to go`} /> : null}
        </Pass>
        <Pass
          id="group"
          icon="group"
          title={W.ajo.en}
          sub={ajo ? (ajo.in_group ? String(ajo.name) : 'Not in one yet') : ' '}
          value={ajo?.in_group ? (ajo.paid_this_period ? 'Paid' : ajo.on_its_way ? 'Sending' : String(ajo.amount_text)) : undefined}
          hidden={open === 'group'}
          onOpen={() => onOpen('group')}
        >
          {ajo?.in_group ? (
            <span className="block">
              <span className="mb-1.5 flex justify-between text-sm text-secondary"><span>{paid} of {members.length} paid this round</span></span>
              <span className="block h-1.5 overflow-hidden rounded-full bg-fill">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${members.length ? (paid / members.length) * 100 : 0}%` }} />
              </span>
            </span>
          ) : null}
        </Pass>
        <Pass
          id="loan"
          icon="loan"
          title={W.loan.en}
          sub={loan?.ok ? loanSub(loan) : ' '}
          value={loan?.ok ? loanValue(loan) : undefined}
          hidden={open === 'loan'}
          onOpen={() => onOpen('loan')}
        >
          {loan?.view === 'building' ? <Progress pct={(Number(loan.week) / Number(loan.weeks_needed)) * 100} label={`Week ${String(loan.week)} of ${String(loan.weeks_needed)}`} /> : null}
          {loan?.view === 'repay' ? <Progress pct={Number((loan.loan as Row).progress)} label={`${String((loan.loan as Row).repaid_text)} of ${String((loan.loan as Row).total_text)} repaid`} /> : null}
        </Pass>
        <Pass
          id="assets"
          icon="assets"
          title={W.assets.en}
          sub={assets ? (owned.length ? `${verified} of ${owned.length} verified` : 'Add what you own') : ' '}
          hidden={open === 'assets'}
          onOpen={() => onOpen('assets')}
        />
      </CardStack>

      <Section title="Recent activity" action={latest.length > 0 && <button onClick={() => go('record')} className="min-h-11 px-1 text-base font-medium text-accent-ink">See all</button>}>
        <Loaded r={rec} rows={3}>
          {() => latest.length > 0 ? (
            <ListGroup>{latest.map((t) => <TxRow key={String(t.id)} t={t} />)}</ListGroup>
          ) : (
            <EmptyState icon="activity" title="Nothing yet">Money in and out shows here.</EmptyState>
          )}
        </Loaded>
      </Section>
    </div>
  )
}

/** The wallet opened: balance, Add money and Cash out. */
export function WalletDetail({ wallet, version, onOpen }: { wallet: Wallet | null; version: number; onOpen: (d: Detail) => void }) {
  const rec = useTool('my_record', version)
  const recent = ((rec?.recent ?? []) as Row[]).filter((t) => t.kind !== 'adjustment').slice(0, 10)
  useSays(`Wallet: ${wallet ? naira(wallet.NGNT) : 'loading'} available. Buttons: Add money, Cash out. Below: her recent activity, each with its Verified on Stellar tick.`)
  return (
    <>
      <div className="rounded-card p-6 text-white shadow-lift" style={{ background: 'var(--wallet)' }}>
        {wallet ? <AmountDisplay text={naira(wallet.NGNT)} size="xl" label="Available" /> : <Skeleton className="h-14 w-56 opacity-30" />}
        <p className="mt-3 text-sm text-white/75">Naira in your Plus wallet. Only you can spend it.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => onOpen('add_cash')}><Icon name="add" /> {W.addMoney.en}</Button>
        <Button variant="secondary" onClick={() => onOpen('cash_out')}><Icon name="cash" /> {W.cashOut.en}</Button>
      </div>
      <Section title="Recent activity">
        <Loaded r={rec} rows={4}>
          {() => recent.length > 0 ? <ListGroup>{recent.map((t) => <TxRow key={String(t.id)} t={t} />)}</ListGroup> : <EmptyState icon="activity" title="Nothing yet">Money in and out shows here.</EmptyState>}
        </Loaded>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------- Add money

/** Add money: her own bank account number (simulated partner bank), or cash with an agent. */
export function AddCash({ data, version, onAnswer }: Props & { onAnswer: (a: PendingAction) => void }) {
  const bank = useTool('bank_details', version)
  useSays(
    'Add money. ' +
      (bank?.ok ? `Bank transfer: anyone can send naira to her account number ${String(bank.account_number_text)}, ${String(bank.bank_label)}, name ${String(bank.account_name)}. A demo card can simulate a transfer arriving. ` : '') +
      'Or cash: she gives it to Mama Bisi, the Plus agent, then taps Yes when asked.',
  )
  return (
    <>
      <Waiting data={data} onAnswer={onAnswer} />
      <Section title={W.bankTransfer.en}>
        <Loaded r={bank} rows={1}>
          {(b) => b.ok === false ? (
            <Notice>{forScreen(b.text)}</Notice>
          ) : (
            <Card className="space-y-4">
              <p className="text-base text-secondary">Anyone can send you naira from any bank app to:</p>
              <div>
                <p className="text-sm text-secondary">Account number</p>
                <p className="num font-mono text-4xl font-light tracking-wider">{String(b.account_number_text)}</p>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-base">
                <div><dt className="text-sm text-secondary">Bank</dt><dd className="font-medium">{String(b.bank_label)}</dd></div>
                <div><dt className="text-sm text-secondary">Name</dt><dd className="font-medium">{String(b.account_name)}</dd></div>
              </dl>
              <CopyButton text={String(b.account_number)} label="Copy account number" />
              <p className="text-sm text-secondary">It lands in your wallet in seconds. If you have a loan, 10% of it pays that back.</p>
            </Card>
          )}
        </Loaded>
        {bank?.ok !== false && bank && <SimulateTransfer data={data} />}
      </Section>

      <Section title={W.agentCash.en}>
        <ListGroup>
          {[
            ['Give your cash to Mama Bisi', 'The Plus agent at the market'],
            ['She records it with your phone number', 'You get a message in the app'],
            ['Tap Yes: is that right?', 'The naira lands in your wallet'],
          ].map(([a, b], i) => (
            <ListRow key={i} icon={['hand', 'phone', 'check'][i]} iconTone="accent" title={a} subtitle={b} />
          ))}
        </ListGroup>
      </Section>
    </>
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
    <Card className="space-y-4 border border-dashed border-fill-strong bg-surface-2! shadow-none!">
      <p className="flex items-center gap-2 text-sm font-medium text-secondary"><Icon name="star4" /> Demo</p>
      {tx?.status === 'completed' ? (
        <div className="space-y-2 text-center">
          <Tick size="md" />
          <p className="text-lg font-medium">{naira(BigInt(tx.amount))} arrived{secs !== null && ` in ${secs.toFixed(1)} s`}</p>
          <VerifiedMark url={tx.chain_tx_hash ? `${EXPLORER}/tx/${tx.chain_tx_hash}` : null} />
          <Button variant="plain" className="w-full" onClick={() => setTxId(null)}>Simulate another</Button>
        </div>
      ) : txId ? (
        <p className="flex items-center justify-center gap-2 py-3 text-lg text-secondary" role="status"><Spinner /> Partner bank is paying your wallet…</p>
      ) : (
        <>
          <p className="text-base">Pretend someone sent a bank transfer to this account:</p>
          <Segmented label="Amount" value={amount} onChange={setAmount} options={['2000', '5000', '10000'].map((a) => [a, naira(BigInt(a) * 100n)])} />
          {msg && <Notice tone="danger">{msg}</Notice>}
          <Button variant="secondary" className="w-full" loading={busy} onClick={() => void send()}>Simulate transfer received</Button>
          <p className="text-sm text-secondary">From “Chidi Okeke”, via Partner bank (simulated).</p>
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------- Pay

function AmountEntry({ value, onChange, max = 7 }: { value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <div className="space-y-5">
      <div className="py-2 text-center" aria-live="polite">
        <AmountDisplay text={naira(BigInt(value || '0') * 100n)} size="xl" className={value ? '' : 'text-secondary'} />
      </div>
      <NumPad onKey={(k) => onChange(applyKey(value, k, max))} />
    </div>
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
export function Pay({ data, onShop }: Props & { onShop?: (d: 'scan' | 'receive') => void }) {
  const payees = data.payees
  const [tab, setTab] = useState<'saved' | 'phone' | 'bank'>(payees.length > 0 ? 'saved' : 'phone')
  const [who, setWho] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const bank = useBankAccount()
  const { busy, msg, run } = useSubmit()
  const chosen = payees.find((p) => p.name === who) ?? null
  const ready = tab === 'saved' ? Boolean(who) : tab === 'bank' ? Boolean(bank.found) : phone.replace(/\D/g, '').length >= 10
  useSays(
    'Pay. ' +
      (tab === 'saved'
        ? payees.length ? `Saved: ${payees.map((p) => p.account_number ? `${p.name} (bank account)` : p.name).join(', ')}.${who ? ` ${who} is chosen.` : ''}` : 'No saved people yet.'
        : tab === 'bank'
        ? `To a bank account: she picks the bank and types the 10-digit account number${bank.found ? `; account name ${bank.found.account_name}` : ''}.`
        : `Pay a phone number${phone ? ` (${phone} typed)` : ''}. On Plus it goes to their wallet; not on Plus, they get a code for cash at any agent.`) +
      (ready ? ` Amount: ${amount ? naira(BigInt(amount) * 100n) : 'not typed yet'}; then Next.` : ''),
  )
  async function next() {
    const r = tab === 'bank'
      ? await run('prepare_bank_send', { bank: bank.code, account_number: bank.acct, amount })
      : tab === 'saved' && chosen?.account_number
      ? await run('prepare_bank_send', { payee: chosen.name, amount })
      : await run('prepare_pay', tab === 'saved' ? { payee: who, amount } : { phone, name: name.trim() || undefined, amount })
    if (r.ok) setAmount('')
  }
  return (
    <div className="space-y-6">
      {onShop && (
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={() => onShop('scan')}><Icon name="code" /> Scan to pay</Button>
          <Button variant="secondary" onClick={() => onShop('receive')}><Icon name="in" /> My code</Button>
        </div>
      )}
      <Segmented label="Pay" value={tab} onChange={(t) => { setTab(t); setAmount('') }}
        options={[['saved', W.savedPeople.en], ['phone', 'By phone'], ['bank', W.toBank.en]]} />

      {tab === 'saved' ? (
        payees.length === 0 ? (
          <EmptyState icon="person" title="No saved people yet" action={<Button variant="plain" size="md" onClick={() => setTab('phone')}>Pay a phone number</Button>}>
            After you pay someone, tap “Save this person”.
          </EmptyState>
        ) : (
          <Section title={W.whoPay.en}>
            <ListGroup>
              {payees.map((p) => (
                <ListRow key={p.id} icon={p.account_number ? 'bank' : 'person'} iconTone={who === p.name ? 'accent' : 'neutral'} title={p.name}
                  subtitle={p.account_number ? `${p.account_name ?? ''} · ${bankName(p.bank_code)} •••• ${p.account_number.slice(-4)}` : p.phone ? localPhone(p.phone) : undefined}
                  selected={who === p.name} onClick={() => setWho(p.name)} />
              ))}
            </ListGroup>
          </Section>
        )
      ) : tab === 'bank' ? (
        <BankAccountForm b={bank} />
      ) : (
        <Card className="space-y-4">
          <TextField label="Their phone number" value={phone} onChange={setPhone} inputMode="tel" placeholder="0803 555 0101" autoComplete="off" />
          <TextField label="Their name (for your record)" value={name} onChange={setName} placeholder="Mama Ngozi" maxLength={40} />
          <p className="flex gap-2 text-sm text-secondary">
            <Icon name="info" className="mt-0.5" />
            <span>On Plus? It goes straight to their wallet. Not on Plus? They get a text with a code and collect cash at any Plus agent.</span>
          </p>
        </Card>
      )}

      {ready && (
        <Section title={W.howMuch.en}>
          <Card className="space-y-4">
            <AmountEntry value={amount} onChange={setAmount} />
            {msg && <Notice tone="danger">{msg}</Notice>}
            <Button className="w-full" loading={busy} disabled={!amount} onClick={() => void next()}>
              {W.next.en}
            </Button>
          </Card>
        </Section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------- Send to a bank account (piece 7)

const BANKS = NG.bankSend?.banks ?? []
const bankName = (code: string | null | undefined) => BANKS.find((b) => b.code === code)?.name ?? ''
type Found = { account_name: string; bank_name: string; account_text: string }

/** The bank, the 10-digit number, and the account name from the (simulated) name enquiry. */
function useBankAccount() {
  const [code, setCode] = useState(BANKS[0]?.code ?? '')
  const [acct, setAcct] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [looking, setLooking] = useState(false)
  useEffect(() => {
    setFound(null)
    setErr(null)
    if (acct.length !== (NG.bankSend?.accountDigits ?? 10)) return
    let live = true
    setLooking(true)
    void tool('bank_lookup', { bank: code, account_number: acct })
      .then((r) => {
        if (!live) return
        if (r.ok) setFound({ account_name: String(r.account_name), bank_name: String(r.bank_name), account_text: String(r.account_text) })
        else setErr(forScreen(r.text))
      })
      .catch(() => live && setErr('No connection. Try again.'))
      .finally(() => live && setLooking(false))
    return () => { live = false }
  }, [code, acct])
  return { code, setCode, acct, setAcct, found, err, looking }
}

function BankAccountForm({ b }: { b: ReturnType<typeof useBankAccount> }) {
  const [saveAs, setSaveAs] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  return (
    <Card className="space-y-4">
      <label className="block">
        <span className="text-base font-medium">Bank</span>
        <select value={b.code} onChange={(e) => b.setCode(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-control bg-fill px-3 text-lg text-label">
          {BANKS.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
        </select>
      </label>
      <TextField label="Account number (10 digits)" value={b.acct} onChange={(v) => b.setAcct(v.replace(/\D/g, '').slice(0, 10))}
        inputMode="numeric" placeholder="0123456789" maxLength={10} />
      {b.looking && <p className="flex items-center gap-2 text-secondary" role="status"><Spinner /> Checking the account…</p>}
      {b.found && (
        <div className="rounded-control bg-success-soft px-4 py-3 text-success-strong">
          <p className="text-sm">{W.accountName.en}</p>
          <p className="text-xl font-semibold">{b.found.account_name}</p>
          <p className="text-sm">{b.found.bank_name} · {b.found.account_text}</p>
        </div>
      )}
      {b.err && <Notice tone="danger">{b.err}</Notice>}
      {b.found && !saved && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1"><TextField label="Save it as (optional)" value={saveAs} onChange={setSaveAs} placeholder="Landlord" maxLength={40} /></div>
          <Button variant="secondary" size="md" disabled={saveAs.trim().length < 2} onClick={async () => {
            const r = await tool('save_payee', { name: saveAs.trim(), bank: b.code, account_number: b.acct })
            if (r.ok) setSaved(saveAs.trim())
          }}>Save</Button>
        </div>
      )}
      {saved && <Notice tone="success">Saved as {saved}.</Notice>}
      <p className="flex gap-2 text-sm text-secondary">
        <Icon name="info" className="mt-0.5" />
        <span>It goes on Stellar to the partner bank, which pays the account. Banks and names are simulated.</span>
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------- Ajo

export function Ajo({ version }: Props) {
  const g = useTool('group_status', version)
  const { busy, msg, run } = useSubmit()
  useSays(g ? `Ajo. ${g.text}${g.in_group && !g.paid_this_period && !g.on_its_way ? ' Button: Pay my part.' : ''} Each paid member has a Verified on Stellar tick.` : 'Ajo, loading.')
  return (
    <Loaded r={g} rows={5}>
      {(g) => !g.in_group ? (
        <EmptyState icon="group" title="Not in an ajo yet">{forScreen(g.text)}</EmptyState>
      ) : (
        <AjoBody g={g} busy={busy} msg={msg} pay={() => void run('prepare_ajo_contribution', {})} />
      )}
    </Loaded>
  )
}

function AjoBody({ g, busy, msg, pay }: { g: ToolResult; busy: boolean; msg: string | null; pay: () => void }) {
  const members = (g.members ?? []) as Row[]
  const paid = members.filter((m) => m.paid_this_round).length
  const n = members.length
  const me = members.find((m) => m.is_me)
  const days = Number(g.period_days)
  // Her turn: rounds from now (0 = this round), on the date that round pays out.
  const ahead = me && n ? (Number(me.position) - Number(g.turn) + n) % n : null
  const herDay = ahead === null ? null : new Date(new Date(String(g.next_due)).getTime() + ahead * days * 86_400_000)
  const pot = BigInt(String(g.amount_minor ?? 0)) * BigInt(n)
  return (
    <>
      <Card className="space-y-4">
        <div>
          <h2 className="text-2xl font-semibold">{String(g.name)}</h2>
          <p className="text-base text-secondary">{String(g.amount_text)} each, every {Number(g.period_days) === 1 ? 'day' : `${String(g.period_days)} days`}</p>
        </div>
        <div>
          <div className="mb-1.5 flex justify-between text-sm text-secondary"><span>{paid} of {members.length} paid</span><span>this round</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-fill" aria-hidden="true">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${members.length ? (paid / members.length) * 100 : 0}%` }} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <div><dt className="text-sm text-secondary">Contribution</dt><dd className="num text-lg font-medium">{String(g.amount_text)} / {days === 1 ? 'day' : `${days} days`}</dd></div>
          <div><dt className="text-sm text-secondary">{W.members.en}</dt><dd className="num text-lg font-medium">{n}</dd></div>
          <div><dt className="text-sm text-secondary">Payout</dt><dd className="num text-lg font-medium">{naira(pot)}</dd></div>
          <div><dt className="text-sm text-secondary">Your turn</dt><dd className="text-lg font-medium">{ahead === null ? '—' : ahead === 0 ? 'This round' : `${herDay!.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })}`}</dd></div>
        </dl>
        <p className="text-base">
          This round's pot goes to <b className="font-semibold">{members.find((m) => m.is_turn)?.is_me ? 'you' : String(g.turn_name)}</b> on{' '}
          {formatTime(String(g.next_due), { weekday: 'long' })}.
        </p>
        {!g.paid_this_period && !g.on_its_way && (
          <Button className="w-full" loading={busy} onClick={pay}>
            {W.payMyPart.en} · {String(g.amount_text)}
          </Button>
        )}
        {msg && <Notice tone="danger">{msg}</Notice>}
      </Card>
      <Section title={W.members.en}>
        <ListGroup>
          {members.map((m) => (
            <ListRow
              key={String(m.position)}
              icon="person"
              iconTone={m.is_me ? 'accent' : 'neutral'}
              title={`${String(m.name)}${m.is_me ? ' (you)' : ''}`}
              subtitle={m.is_turn ? 'Collects this round' : undefined}
              trailing={m.paid_this_round ? <VerifiedMark url={(m.url as string | null) ?? (g.contract_url as string | null)} label="Paid" /> : m.is_me && g.on_its_way ? <VerifiedMark pending pendingLabel="Sending" /> : <span className="text-sm text-secondary">{W.notYet.en}</span>}
            />
          ))}
        </ListGroup>
        <p className="px-1 text-sm text-secondary">Each tick is verified on Stellar, not just in our records.</p>
      </Section>
      <Vouches />
    </>
  )
}

// ---------------------------------------------------------------------------- Vouches (piece 10)

/** Vouch for an ajo member's next loan (her PIN), see who vouched for her, withdraw a waiting one. */
function Vouches() {
  const [bump, setBump] = useState(0)
  const v = useTool('my_vouches', bump)
  const { busy, msg, run } = useSubmit()
  if (!v?.ok) return null
  const can = (v.can_vouch_for ?? []) as Row[]
  const given = ((v.given ?? []) as Row[]).filter((x) => x.status === 'active')
  const received = ((v.received ?? []) as Row[]).filter((x) => x.status === 'active')
  if (!can.length && !given.length && !received.length) return null
  const after = (r: ToolResult) => { if (r.ok) setBump((b) => b + 1) }
  return (
    <Section title="Vouch for a member's loan">
      <ListGroup>
        {can.map((p) => {
          const mine = given.find((g) => g.other_user_id === p.user_id)
          return (
            <ListRow key={String(p.user_id)} icon="vouch" iconTone={mine ? 'success' : 'neutral'} title={String(p.name)}
              subtitle={mine ? <span className="inline-flex flex-wrap items-center gap-2">You vouch for her next loan <VerifiedMark url={mine.credit_tx_hash ? `${EXPLORER}/tx/${String(mine.credit_tx_hash)}` : null} pending={!mine.credit_tx_hash} /></span>
                : p.ok ? 'Her next loan needs less collateral with two vouches' : forScreen(String(p.why ?? ''))}
              trailing={mine ? <Button variant="plain" size="md" loading={busy} onClick={async () => after(await run('withdraw_vouch', { vouch_id: mine.id }))}>Withdraw</Button>
                : p.ok ? <Button size="md" loading={busy} onClick={async () => after(await run('prepare_vouch', { name: p.name }))}>Vouch</Button> : undefined} />
          )
        })}
      </ListGroup>
      {received.length > 0 && <Notice tone="success">{received.map((x) => String(x.other_name)).join(' and ')} vouched for your next loan.</Notice>}
      {msg && <Notice tone="danger">{msg}</Notice>}
      <p className="px-1 text-sm text-secondary">Vouching takes your PIN and is recorded on Stellar. No money is ever taken from you. If a loan you vouched for isn't repaid, you can't vouch for 6 months.</p>
    </Section>
  )
}

// ---------------------------------------------------------------------------- Loan
// Before unlock: her progress ("week 4 of 6") and an estimate, not an offer; never "rejected" or
// "not eligible". Unlocked: the offer, why, what limits it, and the ladder, before she accepts
// (with her PIN). With a loan open: what is left, repay now, more time, smaller payments.

function Progress({ pct, label }: { pct: number; label?: string }) {
  return (
    <span className="block">
      {label && <span className="mb-1.5 flex justify-between text-sm text-secondary"><span>{label}</span></span>}
      <span className="block h-1.5 overflow-hidden rounded-full bg-fill">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
    </span>
  )
}

function loanLine(l: ToolResult): string {
  const v = l.loan as Row | undefined
  if (l.view === 'repay' && v) return `${String(v.outstanding_text)} left of ${String(v.total_text)}`
  if (l.view === 'offer') return `offer of ${String((l.offer as Row).amount_text)}`
  if (l.view === 'building') return `building her history, week ${String(l.week)} of ${String(l.weeks_needed)}`
  return 'new borrowing paused'
}
function loanSub(l: ToolResult): string {
  if (l.view === 'repay') return (l.loan as Row).overdue ? 'A payment is due' : 'Repaying from money in'
  if (l.view === 'offer') return 'Offer ready'
  if (l.view === 'building') return W.buildingHistory.en
  return 'Paused for now'
}
function loanValue(l: ToolResult): string | undefined {
  if (l.view === 'repay') return String((l.loan as Row).outstanding_text)
  if (l.view === 'offer') return String((l.offer as Row).amount_text)
  return undefined
}

function Building({ l }: { l: ToolResult }) {
  const list = (l.checklist ?? []) as Row[]
  const est = l.estimate as Row
  return (
    <>
      <Card>
        <p className="text-base font-medium"><Bilingual main={W.buildingHistory.en} sub={yo('buildingHistory')} /></p>
        <p className="mt-1 text-3xl font-semibold">Week {String(l.week)} of {String(l.weeks_needed)}</p>
        <div className="mt-4"><Progress pct={(Number(l.week) / Number(l.weeks_needed)) * 100} /></div>
      </Card>
      <ListGroup>
        {list.map((c) => (
          <ListRow key={String(c.key)} icon={c.done ? 'check' : 'clock'} iconTone={c.done ? 'success' : 'neutral'} title={String(c.label)} subtitle={String(c.detail)} />
        ))}
      </ListGroup>
      <Card>
        <p className="text-sm font-medium text-secondary"><Bilingual main={W.estimateNotOffer.en} sub={yo('estimateNotOffer')} /></p>
        <p className="num mt-1 text-2xl font-semibold">{String(est.low_text)} to {String(est.high_text)}</p>
        <p className="mt-2 text-sm text-secondary">What a first loan could look like once your history is built, from what you do now. It can change.</p>
      </Card>
    </>
  )
}

function Ladder({ l }: { l: ToolResult }) {
  const steps = (l.ladder ?? []) as Row[]
  const now = steps.findIndex((x) => x.current)
  return (
    <Section title={<Bilingual main={W.nextLoans.en} sub={yo('nextLoans')} />}>
      <ListGroup>
        {steps.map((s, i) => (
          <ListRow key={i} icon={s.current ? 'star' : 'up'} iconTone={s.current ? 'accent' : 'neutral'}
            title={`${i === now ? 'Now' : i === now + 1 ? 'Next loan' : 'Then'}: up to ${String(s.max_text)} at ${String(s.cost_pct)}%`}
            subtitle={`Collateral ${String(s.collateral_text)} · approval ${String(s.approval)}`} />
        ))}
      </ListGroup>
    </Section>
  )
}

type Run = (name: string, args: Row) => Promise<ToolResult>

function Offer({ l, busy, run }: { l: ToolResult; busy: boolean; run: Run }) {
  const o = l.offer as Row
  const a = l.affordability as Row
  const why = (l.why ?? []) as Row[]
  return (
    <>
      <Card>
        <AmountDisplay text={String(o.amount_text)} size="lg" label={<Bilingual main={W.youReceive.en} sub={yo('youReceive')} />} />
        <dl className="mt-4 divide-y divide-hairline text-lg">
          <div className="flex justify-between py-2"><dt className="text-secondary">Cost</dt><dd className="num font-medium">{String(o.cost_text)}</dd></div>
          <div className="flex justify-between py-2"><dt className="font-medium">Total to repay</dt><dd className="num font-semibold">{String(o.total_text)}</dd></div>
        </dl>
        <p className="mt-2 text-sm text-secondary">From {String(l.lender)}. Repay {String(o.repay_pct)}% of every money-in, and at least {String(o.minimum_text)} every two weeks.</p>
      </Card>
      <RepayExample pct={Number(o.repay_pct)} />
      <VouchNote l={l} />
      <Section title={<Bilingual main={W.whyThisOffer.en} sub={yo('whyThisOffer')} />}>
        <ListGroup>
          {why.map((w) => (
            <ListRow key={String(w.key)} icon="check" iconTone="success" title={`${String(w.label)} · ${String(w.weight)}%`} subtitle={String(w.detail)} />
          ))}
        </ListGroup>
      </Section>
      <Section title="Affordability first">
        <ListGroup>
          {a.asset ? <ListRow icon="stock" title={String(a.asset)} subtitle={`Estimated ${String(a.estimated_value_text)} · lending value ${String(a.lending_value_text)}`} /> : null}
          <ListRow icon="wallet" title={`You can afford ${String(a.affordable_text)}`} subtitle="From 10% of what usually comes in, plus the two-weekly minimums" />
          <ListRow icon="shield" title={`Offer ${String(o.amount_text)}: the lower one wins`} subtitle={`Collateral needed now: ${String(o.collateral_pct)}% (${String(a.collateral_needed_text)})${(l.vouch as Row | undefined)?.applied ? ` instead of ${String((l.vouch as Row).collateral_pct_without)}%, thanks to your vouches` : ''}`} />
        </ListGroup>
      </Section>
      <Ladder l={l} />
      <Button className="w-full" loading={busy} onClick={() => void run('prepare_loan', {})}>
        {W.acceptLoan.en}
      </Button>
    </>
  )
}

/** How repaying feels: a sale, and the loan's share of it, automatically. */
function RepayExample({ pct }: { pct: number }) {
  const sale = 10_000n * 100n
  return (
    <Notice tone="info">
      Sell <b className="num">{naira(sale)}</b> → <b className="num">{naira((sale * BigInt(Math.round(pct * 100))) / 10_000n)}</b> goes to the loan automatically.
    </Notice>
  )
}

/** On the offer: who vouched, and why that lowers the collateral (or how many more would). */
function VouchNote({ l }: { l: ToolResult }) {
  const v = l.vouch as Row | undefined
  if (!v || !Number(v.count)) return null
  return (
    <Notice tone={v.applied ? 'success' : undefined}>
      <span className="font-medium">{((v.names ?? []) as string[]).join(' and ')} vouched for you.</span>{' '}
      {v.applied ? `Two ajo members in good standing back this loan, so it needs ${String(v.collateral_pct)}% collateral instead of ${String(v.collateral_pct_without)}%.`
        : `One more vouch from an ajo member in good standing would lower the collateral this loan needs (now ${String(v.collateral_pct_without)}%).`}
    </Notice>
  )
}

function Repaying({ l, busy, run }: { l: ToolResult; busy: boolean; run: Run }) {
  const v = l.loan as Row
  const dueNow = BigInt(String(v.due_now_minor))
  return (
    <>
      <Card>
        <AmountDisplay text={String(v.outstanding_text)} size="lg" label="Left to repay" />
        <div className="mt-4"><Progress pct={Number(v.progress)} label={`${String(v.repaid_text)} of ${String(v.total_text)} repaid${v.in_flight_text ? ` (${String(v.in_flight_text)} sending)` : ''}`} /></div>
        <p className="mt-3 text-base text-secondary">
          {String(v.repay_pct)}% of every money-in pays it by itself.{' '}
          {v.overdue ? <b className="text-warning-strong">{String(v.due_now_text)} is due now.</b> : <>Next: at least {String(v.due_now_text)} by {String(v.next_due_text)}.</>}
        </p>
        {v.grace_until ? <p className="mt-1 text-sm text-secondary">You have a few days' grace. No extra cost.</p> : null}
      </Card>
      <RepayExample pct={Number(v.repay_pct)} />
      {v.status === 'late' && <Notice tone="warning">A payment is late. You can ask for smaller payments below. Borrowing more waits until this is repaid.</Notice>}
      {v.borrowing_paused ? <Notice>New borrowing is paused until this loan is repaid.</Notice> : null}
      <div className="grid gap-3">
        {dueNow > 0n && <Button loading={busy} onClick={() => void run('prepare_loan_repay', { amount: String(dueNow / 100n) })}>{W.repayNow.en}: {String(v.due_now_text)}</Button>}
        <Button variant="plain" loading={busy} onClick={() => void run('prepare_loan_repay', {})}>Repay all: {String(v.outstanding_text)}</Button>
        {v.can_extend ? <Button variant="plain" loading={busy} onClick={() => void run('loan_more_time', {})}>{W.needMoreTime.en}</Button> : null}
        {v.can_restructure ? <Button variant="plain" loading={busy} onClick={() => void run('loan_restructure', {})}>{W.smallerPayments.en}</Button> : null}
      </div>
      <ListGroup>
        <ListRow icon="loan" title={`You received ${String(v.principal_text)}`} subtitle={`Cost ${String(v.cost_text)} · total ${String(v.total_text)}`} />
        {((v.vouched_by ?? []) as string[]).length > 0 && <ListRow icon="vouch" title={`Vouched for by ${((v.vouched_by ?? []) as string[]).join(' and ')}`} subtitle="Ajo members; recorded on this loan on Stellar" />}
      </ListGroup>
      {/* The agreement and every repayment are on plus_credit: any lender can read them from Stellar. */}
      <div className="px-1"><VerifiedMark url={v.credit_tx_hash ? `${EXPLORER}/tx/${String(v.credit_tx_hash)}` : null} pending={!v.credit_tx_hash} /></div>
    </>
  )
}

export function Loan({ version }: Props) {
  const l = useTool('loan_status', version)
  const { busy, msg, run } = useSubmit()
  useSays(l ? `Loan. ${forScreen(String(l.text ?? ''))}` +
    (l.view === 'offer' ? ' Button: Accept with my PIN.' : l.view === 'repay' ? ' Buttons: Repay now, Repay all, I need more time.' : '') : 'Loan, loading.')
  return (
    <>
      <Loaded r={l} rows={3}>
        {(l) => !l.ok ? <EmptyState icon="loan" title="Not here yet">{forScreen(l.text)}</EmptyState>
          : l.view === 'building' ? <Building l={l} />
          : l.view === 'offer' ? <Offer l={l} busy={busy} run={run} />
          : l.view === 'repay' ? <Repaying l={l} busy={busy} run={run} />
          : <Card><p className="text-lg">{forScreen(String(l.text))}</p></Card>}
      </Loaded>
      {msg && <Notice tone="danger">{msg}</Notice>}
      <Notice><Bilingual main={W.nobodyElse.en} sub={yo('nobodyElse')} /></Notice>
      <p className="px-1 text-sm text-secondary">Loans come from a partner lender (simulated). The money moves on Stellar Testnet.</p>
    </>
  )
}

// ---------------------------------------------------------------------------- Savings (piece 11)

const kobo = (text: unknown) => BigInt(String(text ?? '').replace(/[^0-9]/g, '') || '0')
function savedPct(s: ToolResult): number {
  const goal = kobo(s.goal_text)
  return goal > 0n ? Math.min(100, Number((kobo(s.saved_text) * 100n) / goal)) : 0
}

/** Her savings goal: a pot on the plus contract that pays back only to her. */
export function Savings({ data, version }: Props) {
  const s = useTool('savings_status', version)
  const rec = useTool('my_record', version)
  const [mode, setMode] = useState<'add' | 'out'>('add')
  const [amount, setAmount] = useState('')
  const [goalName, setGoalName] = useState('')
  const [goalAmount, setGoalAmount] = useState('')
  const { busy, msg, run } = useSubmit()
  const [autoBusy, setAutoBusy] = useState(false)
  const moves = ((rec?.recent ?? []) as Row[]).filter((t) => t.kind === 'saved' || t.kind === 'savings_out').slice(0, 5)
  const auto = Number(s?.auto_save_pct ?? (data.me?.auto_save_bps ?? 0) / 100)
  useSays(s ? `Savings. ${forScreen(String(s.text))}` +
    (s.has_goal ? ` Buttons: ${W.addToSavings.en}, ${W.takeOut.en}. Auto-save choices: 0, 5, 10, 20 percent.` : ` Fields: what she is saving for, the goal amount; button ${W.setGoal.en}.`) : 'Savings, loading.')
  const setAuto = async (pct: number) => {
    setAutoBusy(true)
    await tool('set_auto_save', { percent: pct }).catch(() => null)
    setAutoBusy(false)
    void data.refresh()
  }
  return (
    <Loaded r={s} rows={3}>
      {(s) => !s.has_goal ? (
        <Card className="space-y-4">
          <p className="text-lg">What are you saving for?</p>
          <TextField label="Your goal" value={goalName} onChange={setGoalName} placeholder="New stall shade" />
          <TextField label="How much (₦)" value={goalAmount} onChange={(v) => setGoalAmount(v.replace(/[^0-9]/g, '').slice(0, 7))} inputMode="numeric" placeholder="50000" />
          {msg && <Notice tone="danger">{msg}</Notice>}
          <Button className="w-full" loading={busy} disabled={!goalName.trim() || !goalAmount} onClick={async () => {
            const r = await run('set_savings_goal', { name: goalName.trim(), amount: goalAmount })
            if (r.ok) void data.refresh()
          }}>{W.setGoal.en}</Button>
        </Card>
      ) : (
        <>
          <Card className="space-y-4">
            <div>
              <p className="text-base text-secondary">{W.goal.en}: {String(s.goal_name)}</p>
              <AmountDisplay text={String(s.saved_text)} size="lg" />
              <p className="text-base text-secondary">of {String(s.goal_text)}</p>
            </div>
            <Progress pct={savedPct(s)} label={`${String(s.left_text)} to go`} />
            <p className="flex items-center gap-2 text-sm text-secondary"><Icon name="lock" /> <Bilingual main={W.onlyYou.en} sub={yo('onlyYou')} /></p>
          </Card>
          {s.ready ? (
            <Card className="space-y-4">
              <Segmented<'add' | 'out'> label="Add or take out" value={mode} onChange={(m) => { setMode(m); setAmount('') }}
                options={[['add', W.addToSavings.en], ['out', W.takeOut.en]]} />
              <AmountEntry value={amount} onChange={setAmount} max={6} />
              {mode === 'out' && <p className="text-sm text-secondary">Above {naira(BigInt(NG.pinThreshold) * 100n)} you type your PIN.</p>}
              {msg && <Notice tone="danger">{msg}</Notice>}
              <Button className="w-full" loading={busy} disabled={!amount} onClick={async () => {
                const r = await run(mode === 'add' ? 'prepare_save' : 'prepare_withdraw_savings', { amount })
                if (r.ok) setAmount('')
              }}>{W.next.en}</Button>
            </Card>
          ) : (
            <Notice>Your savings pot is being set up on Stellar. A few seconds.</Notice>
          )}
          <Section title={W.autoSave.en}>
            <Card className="space-y-3">
              <Segmented<string> label={W.autoSave.en} value={String(auto)} onChange={(v) => void setAuto(Number(v))}
                options={[0, 5, 10, 20].map((p) => [String(p), p === 0 ? 'Off' : `${p}%`] as [string, string])} />
              <p className="text-sm text-secondary">{autoBusy ? 'Saving…' : <Bilingual main={W.autoSaveHow.en} sub={yo('autoSaveHow')} />}</p>
            </Card>
          </Section>
          <Section title={W.latest.en}>
            {moves.length > 0 ? <ListGroup>{moves.map((t) => <TxRow key={String(t.id)} t={t} />)}</ListGroup>
              : <EmptyState icon="savings" title="Nothing saved yet">What you save shows here, each one on Stellar.</EmptyState>}
          </Section>
        </>
      )}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------- Cash out

type ShownCode = { id: string; code: string } | null

export function CashOut({ version, shownCode, onShowCode }: Props & { shownCode: ShownCode; onShowCode: (c: ShownCode) => void }) {
  const list = useTool('cash_outs', version)
  const [amount, setAmount] = useState('')
  const shown = shownCode
  const setShown = onShowCode
  const { busy, msg, run } = useSubmit()
  const open = ((list?.cash_outs ?? []) as Row[]).filter((c) => c.status === 'issued' && new Date(String(c.expires_at)) > new Date())
  useSays(
    `Cash out. ${open.length ? `Waiting for an agent: ${open.map((c) => String(c.amount_text)).join(', ')}${shown ? '; a code is showing on screen (never read it out)' : '; each has a New code button'}. ` : ''}` +
      `She types how much cash she needs${amount ? ` (${naira(BigInt(amount) * 100n)} typed)` : ''} and taps Next; after her Yes she gets a 6-digit code for the agent.`,
  )
  return (
    <>
      {open.map((c) => (
        <Card key={String(c.id)} className="space-y-3">
          <p className="text-xl font-medium">{String(c.amount_text)} waiting for an agent</p>
          <p className="text-sm text-secondary">Unused until {new Date(String(c.expires_at)).toLocaleDateString('en-NG')}, then it comes back to your wallet.</p>
          {shown && shown.id === c.id ? (
            <CodeBox code={shown.code} />
          ) : (
            <Button variant="secondary" className="w-full" loading={busy} onClick={async () => {
              const r = await run('new_cashout_code', { cash_out_id: c.id })
              if (r.ok) setShown({ id: String(c.id), code: String(r.cash_out_code) })
            }}>
              {W.newCode.en}
            </Button>
          )}
        </Card>
      ))}
      <Section title="How much cash do you need?">
        <Card className="space-y-4">
          <AmountEntry value={amount} onChange={setAmount} max={6} />
          {msg && <Notice tone="danger">{msg}</Notice>}
          <Button className="w-full" loading={busy} disabled={!amount} onClick={async () => {
            const r = await run('prepare_cashout', { amount })
            if (r.ok) setAmount('')
          }}>
            {W.next.en}
          </Button>
        </Card>
      </Section>
      <p className="px-1 text-sm text-secondary">The money waits for a registered agent. Only someone with your code gets it; after {NG.cashOutCode?.returnAfterDays ?? 7} days it comes back to you.</p>
    </>
  )
}

// ---------------------------------------------------------------------------- Activity

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const KIND_ICON: Record<string, string> = { incoming: 'in', pay: 'pay', group_contribution: 'group', advance: 'advance', repay: 'advance', loan: 'loan', loan_repay: 'loan', cash_out: 'cash', saved: 'savings', savings_out: 'savings' }

/** One transaction with its "Verified on Stellar" tick, which links to the transaction. */
function TxRow({ t }: { t: Row }) {
  return (
    <ListRow
      icon={KIND_ICON[String(t.kind)] ?? 'record'}
      iconTone={t.outgoing ? 'neutral' : 'success'}
      title={cap(String(t.label))}
      subtitle={when(String(t.at))}
      trailing={
        <span className="flex flex-col items-end gap-0.5">
          <span className={`num text-lg font-medium ${t.outgoing ? '' : 'text-success'}`}>{t.outgoing ? '−' : '+'}{String(t.amount_text)}</span>
          {t.status === 'pending' ? <VerifiedMark pending pendingLabel="Sending" /> : t.url ? <VerifiedMark url={String(t.url)} label="Verified" /> : null}
        </span>
      }
    />
  )
}

// ---------------------------------------------------------------------------- Share with a lender (piece 9)

const SHARE_STATUS: Record<string, [string, string]> = {
  active: ['Not opened yet', 'text-secondary'],
  used: ['Opened by a lender', 'text-success'],
  expired: ['Expired', 'text-tertiary'],
  revoked: ['Revoked', 'text-tertiary'],
}

/** Consent first (what the lender sees, what they never see), then her PIN in the confirm sheet. */
function ShareRecord({ version }: { version: number }) {
  const [asking, setAsking] = useState(false)
  const [bump, setBump] = useState(0)
  const list = useTool('record_shares', version + bump)
  const { busy, msg, run } = useSubmit()
  const shares = ((list?.shares ?? []) as Row[]).slice(0, 5)
  const open = shares.filter((s) => s.status === 'active' || s.status === 'used')
  return (
    <Section title="Share with a lender">
      {asking ? (
        <Card className="space-y-4">
          <div>
            <p className="text-base font-medium">The lender sees, read from Stellar:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-base text-secondary">
              <li>how long you've been with Plus</li>
              <li>your ajo payments, and how many were on time</li>
              <li>how steadily you save</li>
              <li>your verified assets: level and status only</li>
              <li>loans taken and repaid, and your loan now</li>
            </ul>
          </div>
          <Notice>Never your name, phone number, ID, photos or where you live or trade.</Notice>
          <p className="text-sm text-secondary">You get a code for one lender. It works for 24 hours. You can revoke it any time.</p>
          {msg && <Notice tone="danger">{msg}</Notice>}
          <div className="grid gap-2">
            <Button loading={busy} onClick={async () => { const r = await run('share_record', {}); if (r.ok) { setAsking(false); setBump((b) => b + 1) } }}>
              <Icon name="shield" /> I agree: share with my PIN
            </Button>
            <Button variant="plain" onClick={() => setAsking(false)}>Not now</Button>
          </div>
        </Card>
      ) : (
        <Button variant="secondary" className="w-full" onClick={() => setAsking(true)}><Icon name="shield" /> Share my record</Button>
      )}
      {shares.length > 0 && (
        <ListGroup>
          {shares.map((s) => {
            const [label, tone] = SHARE_STATUS[String(s.status)] ?? ['', '']
            const live = s.status === 'active' || s.status === 'used'
            return (
              <ListRow key={String(s.id)} icon="shield" title={formatTime(String(s.created_at), { date: true })}
                subtitle={<span className={tone}>{label}{Number(s.views) > 0 ? ` · ${String(s.views)} view${Number(s.views) === 1 ? '' : 's'}` : ''}{live ? ` · until ${formatTime(String(s.expires_at))}` : ''}</span>}
                trailing={live ? <Button variant="plain" size="md" onClick={async () => { await run('revoke_record_share', { share_id: s.id }); setBump((b) => b + 1) }}>Revoke</Button> : undefined} />
            )
          })}
        </ListGroup>
      )}
      {open.length > 1 && <Button variant="plain" className="w-full" onClick={async () => { await run('revoke_record_share', {}); setBump((b) => b + 1) }}>Revoke all</Button>}
    </Section>
  )
}

export function Record({ version }: Props) {
  const r = useTool('my_record', version)
  const latest = ((r?.recent ?? []) as Row[]).filter((t) => t.kind !== 'adjustment').slice(0, 5)
  useSays(r ? `Activity. ${r.text} Latest: ${latest.map((t) => `${String(t.label)} ${t.outgoing ? '-' : '+'}${String(t.amount_text)}${t.counterparty ? ` (${String(t.counterparty)})` : ''}`).join(', ') || 'nothing yet'}.` : 'Activity, loading.')
  return (
    <Loaded r={r} rows={4}>
      {(r) => {
        const totals = (r.totals ?? {}) as Row
        const recent = (r.recent ?? []) as Row[]
        return (
          <div className="space-y-6">
            <Card>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
                {([['Came in', totals.received_text], ['Paid', totals.paid_text], ['Into ajo', totals.ajo_text], ['Agent cash-ins', r.cash_ins]] as const).map(([k, v]) => (
                  <div key={k}><dt className="text-sm text-secondary">{k}</dt><dd className="num text-2xl font-light">{String(v ?? '—')}</dd></div>
                ))}
              </dl>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
                <p className="text-sm text-secondary">{String(r.confirmed_on_stellar)} transactions on Stellar since your wallet opened, each checkable. Your name is never on it.</p>
                {typeof r.account_url === 'string' && <VerifiedMark url={r.account_url} />}
              </div>
            </Card>
            <ShareRecord version={version} />
            {recent.length > 0 ? (
              <ListGroup>{recent.map((t) => <TxRow key={String(t.id)} t={t} />)}</ListGroup>
            ) : (
              <EmptyState icon="activity" title="Nothing yet">Add money by bank transfer or with an agent, and it shows here.</EmptyState>
            )}
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------- Profile

export function Settings({ data, version, onSignOut }: Props & { onSignOut: () => void }) {
  const me = useTool('get_user', version)
  const [pin, setPin] = useState('')
  const { busy, msg, run } = useSubmit()
  const [saved, setSaved] = useState(false)
  const limits = (me?.limits ?? null) as { tier: number; daily_text: string; balance_text: string; advances: boolean } | null
  const name = data.me?.name ?? ''
  useSays(
    `Profile: ${name}${limits ? `, level ${limits.tier}. Limits: send ${limits.daily_text} a day, hold up to ${limits.balance_text}` : ''}. ` +
      'A PIN pad to set her PIN: she types it herself, never out loud. A Sign out button.',
  )
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <span className="grid size-16 shrink-0 place-items-center rounded-full bg-accent-soft text-2xl font-medium text-accent-ink">{name.slice(0, 1).toUpperCase()}</span>
        <div className="min-w-0">
          <p className="truncate text-2xl font-semibold">{name}</p>
          {limits && <p className="text-base text-secondary">Level {limits.tier} · {limits.tier >= 2 ? 'NIN checked' : 'Photo checked'}</p>}
        </div>
      </div>
      <Loaded r={me} rows={2}>
        {() => limits && (
          <Section title="Limits">
            <ListGroup>
              <ListRow icon="pay" title="Send per day" trailing={<span className="num font-medium">{limits.daily_text}</span>} />
              <ListRow icon="wallet" title="Hold up to" trailing={<span className="num font-medium">{limits.balance_text}</span>} />
              {me?.virtual_account ? <ListRow icon="bank" title="Bank transfers in" subtitle={String(me.bank_label)} trailing={<span className="num font-mono text-base">{String(me.virtual_account)}</span>} /> : null}
            </ListGroup>
          </Section>
        )}
      </Loaded>
      <Loaded r={me} rows={1}>
        {() => <StellarDetails pub={(me?.stellar_pub as string | null) ?? null} />}
      </Loaded>
      <Section title="PIN">
        <Card className="space-y-3">
          <p className="text-sm text-secondary">Up to {naira(BigInt(NG.pinThreshold) * 100n)} you can just say yes. Above that, type your PIN here on the screen. Never say it out loud.</p>
          <PinPad value={pin} onChange={setPin} />
          {msg && <Notice tone="danger">{msg}</Notice>}
          {saved && <Notice tone="success">PIN saved.</Notice>}
          <Button className="w-full" loading={busy} disabled={pin.length < 4} onClick={async () => {
            const r = await run('set_pin', { pin })
            setPin('')
            setSaved(Boolean(r.ok))
          }}>Save PIN</Button>
        </Card>
      </Section>
      <Button variant="destructive" className="w-full" onClick={onSignOut}><Icon name="signOut" /> {W.signOut.en}</Button>
      <p className="text-center text-sm text-secondary">Demo · test money only</p>
    </div>
  )
}

