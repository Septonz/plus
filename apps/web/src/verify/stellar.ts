// /verify reads a Plus record straight from Stellar testnet: the plus_credit contract (loans,
// assets, vouches), her wallet's history on Horizon (ajo payments into the plus contract, first
// activity) and plus_credit's recent events. Nothing here comes from Plus's database: Plus only
// turned the lender's code into her two public references (her wallet and her plus_credit ref).

export const EXPLORER = 'https://stellar.expert/explorer/testnet'
export const RPC_URL = (import.meta.env.VITE_STELLAR_RPC_URL as string | undefined) || 'https://soroban-testnet.stellar.org'
export const HORIZON_URL = 'https://horizon-testnet.stellar.org'
/** Contract IDs are public (docs/deployments.md). */
export const PLUS_CONTRACT = (import.meta.env.VITE_PLUS_CONTRACT_ID as string | undefined) || 'CA4VEZZOSQR3RLPN2SF4FLAB5FVPLYH3C635ZSSIEJDE4ZPADGMFQJP4'
export const CREDIT_CONTRACT = (import.meta.env.VITE_PLUS_CREDIT_CONTRACT_ID as string | undefined) || 'CCLO7QV3LC4MPC46ZBYZDGNOVEYTY62SDRV6S4KZ7O5LVAA7RMX6DZCC'
/** Any funded account works as the source of a read-only simulation (Plus's partner, public). */
/** The ledger plus_credit was deployed in: nothing about it is older. */
const CREDIT_FIRST_LEDGER = Number(import.meta.env.VITE_PLUS_CREDIT_FIRST_LEDGER ?? 5_667_189)
/** A getEvents cursor starts with the ledger sequence (TOID). */
const cursorLedger = (c: string) => Number(BigInt(c.split('-')[0]) >> 32n)
const SIM_SOURCE = 'GCHDENOIJ5JFA3JU3OPW3LZSLHR57HCOHA7ZYQSRYG6MHHOFSAM4CWWZ'
const UNIT = 10_000_000n // 7 decimals

export type Sdk = typeof import('@stellar/stellar-sdk')
let sdk: Promise<Sdk> | null = null
/** Loaded once, ahead of the lender's click, so the timing measures Stellar and not the download. */
export const loadSdk = () => (sdk ??= import('@stellar/stellar-sdk'))

export const LOAN_STATUS = ['Active', 'Late', 'Restructured', 'Repaid', 'Default', 'Cancelled'] as const
export const ASSET_LEVEL = ['Registered', 'Evidence verified', 'Community verified', 'Independently verified'] as const
export const ASSET_STATUS = ['Active', 'Under review', 'Lost', 'Stolen', 'Damaged', 'Released'] as const

export type ChainLoan = {
  ref: string; principal: bigint; cost: bigint; total: bigint; repaid: bigint; status: number; collateral: string | null
  collateral_pct: number; vouchers: string[]; opened_at: number; updated_at: number
}
export type ChainAsset = { ref: string; level: number; status: number; pledged_to: string | null; registered_at: number; updated_at: number }
export type AjoPayment = { at: number; group: number; tx: string }
export type ChainEvent = { name: string; at: string; tx: string; ref: string }

export type Record = {
  wallet: string
  firstActivity: number | null
  ajo: AjoPayment[]
  periods: Map<number, number>
  loans: ChainLoan[]
  assets: ChainAsset[]
  vouches: string[]
  events: ChainEvent[]
  eventsFrom: string | null
}

const hex = (b: unknown) => (b instanceof Uint8Array ? Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') : String(b ?? ''))
export const naira = (stroops: bigint) => `₦${(stroops / UNIT).toLocaleString('en-NG')}`

async function simulate(S: Sdk, contract: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const server = new S.rpc.Server(RPC_URL)
  const tx = new S.TransactionBuilder(new S.Account(SIM_SOURCE, '0'), { fee: '100', networkPassphrase: S.Networks.TESTNET })
    .addOperation(new S.Contract(contract).call(fn, ...(args as Parameters<InstanceType<typeof S.Contract>['call']>[1][])))
    .setTimeout(30).build()
  const sim = await server.simulateTransaction(tx)
  if (!S.rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(S.rpc.Api.isSimulationError(sim) ? sim.error : `${fn}: no result`)
  return S.scValToNative(sim.result.retval)
}

const bytes = (S: Sdk, h: string) => S.xdr.ScVal.scvBytes(new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16))) as never)

/** Her loans, assets and waiting vouches on plus_credit. */
async function credit(S: Sdk, ref: string) {
  const [loanRefs, assetRefs, vouches] = await Promise.all([
    simulate(S, CREDIT_CONTRACT, 'loans_of', [bytes(S, ref)]) as Promise<Uint8Array[]>,
    simulate(S, CREDIT_CONTRACT, 'assets_of', [bytes(S, ref)]) as Promise<Uint8Array[]>,
    simulate(S, CREDIT_CONTRACT, 'vouches_for', [bytes(S, ref)]) as Promise<Uint8Array[]>,
  ])
  const [loans, assets] = await Promise.all([
    Promise.all(loanRefs.map(hex).map(async (r) => {
      const l = await simulate(S, CREDIT_CONTRACT, 'loan', [bytes(S, r)]) as globalThis.Record<string, unknown>
      return {
        ref: r, principal: BigInt(l.principal as bigint), cost: BigInt(l.cost as bigint), total: BigInt(l.total as bigint),
        repaid: BigInt(l.repaid as bigint), status: Number(l.status), collateral: l.collateral ? hex(l.collateral) : null,
        collateral_pct: Number(l.collateral_pct), vouchers: ((l.vouchers ?? []) as Uint8Array[]).map(hex),
        opened_at: Number(l.opened_at), updated_at: Number(l.updated_at),
      } satisfies ChainLoan
    })),
    Promise.all(assetRefs.map(hex).map(async (r) => {
      const a = await simulate(S, CREDIT_CONTRACT, 'asset', [bytes(S, r)]) as globalThis.Record<string, unknown>
      return {
        ref: r, level: Number(a.level), status: Number(a.status), pledged_to: a.pledged_to ? hex(a.pledged_to) : null,
        registered_at: Number(a.registered_at), updated_at: Number(a.updated_at),
      } satisfies ChainAsset
    })),
  ])
  return { loans, assets, vouches: vouches.map(hex) }
}

type HorizonOp = {
  type: string; created_at: string; transaction_hash: string; transaction_successful?: boolean
  parameters?: { value: string; type: string }[]
}

/** Her wallet's history: first activity, and every ajo payment (group_contribute on the plus contract). */
async function wallet(S: Sdk, account: string) {
  const ajo: AjoPayment[] = []
  let first: number | null = null
  let url: string | null = `${HORIZON_URL}/accounts/${account}/operations?order=asc&limit=200`
  for (let page = 0; url && page < 10; page++) {
    const r = await fetch(url)
    if (r.status === 404) break
    if (!r.ok) throw new Error(`Horizon ${r.status}`)
    const j = await r.json() as { _embedded: { records: HorizonOp[] }; _links: { next?: { href: string } } }
    const recs = j._embedded.records
    if (first === null && recs[0]) first = Date.parse(recs[0].created_at)
    for (const op of recs) {
      if (op.type !== 'invoke_host_function' || op.transaction_successful === false || !op.parameters || op.parameters.length < 4) continue
      const [c, fn, , group] = op.parameters.map((p) => S.scValToNative(S.xdr.ScVal.fromXDR(p.value, 'base64')))
      if (String(c) === PLUS_CONTRACT && String(fn) === 'group_contribute') ajo.push({ at: Date.parse(op.created_at), group: Number(group), tx: op.transaction_hash })
    }
    url = recs.length === 200 ? j._links.next?.href ?? null : null
  }
  const groups = [...new Set(ajo.map((p) => p.group))]
  const periods = new Map<number, number>()
  await Promise.all(groups.map(async (g) => {
    const info = await simulate(S, PLUS_CONTRACT, 'group', [S.nativeToScVal(g, { type: 'u32' })]).catch(() => null) as { period_secs?: bigint } | null
    if (info?.period_secs) periods.set(g, Number(info.period_secs))
  }))
  return { first, ajo, periods }
}

const EVENT_NAMES: globalThis.Record<string, string> = {
  loan_opened: 'Loan opened', loan_repayment: 'Repayment', loan_status_changed: 'Loan status changed',
  asset_registered: 'Asset registered', asset_level_changed: 'Asset level changed', asset_status_changed: 'Asset status changed',
  asset_collateral: 'Collateral changed', vouched: 'Vouched for', vouch_revoked: 'Vouch withdrawn', vouched_loan_defaulted: 'Vouched loan defaulted',
}

/** plus_credit's events that mention her (the RPC keeps a limited window of recent ledgers). */
async function events(S: Sdk, refs: Set<string>): Promise<{ list: ChainEvent[]; from: string | null }> {
  const server = new S.rpc.Server(RPC_URL)
  const health = await server.getHealth()
  // From the contract's first ledger (or the oldest the RPC still keeps). The RPC scans a window per
  // request and hands back a cursor, so follow it to the latest ledger.
  const oldest = (health as { oldestLedger?: number }).oldestLedger ?? health.latestLedger - 17_280
  const start = Math.max(oldest, CREDIT_FIRST_LEDGER)
  const out: ChainEvent[] = []
  let cursor: string | undefined
  let from: string | null = null
  for (let page = 0; page < 20; page++) {
    const filters = [{ type: 'contract' as const, contractIds: [CREDIT_CONTRACT] }]
    const r = await server.getEvents(cursor ? { cursor, filters, limit: 500 } : { startLedger: start, filters, limit: 500 })
    if (from === null && r.events[0]) from = r.events[0].ledgerClosedAt
    for (const e of r.events) {
      const topics = e.topic.map((t) => S.scValToNative(t))
      const hit = topics.slice(1).map(hex).find((t) => refs.has(t))
      if (hit) out.push({ name: EVENT_NAMES[String(topics[0])] ?? String(topics[0]), at: e.ledgerClosedAt, tx: e.txHash, ref: hit })
    }
    if (!r.cursor || r.cursor === cursor || cursorLedger(r.cursor) >= health.latestLedger) break
    cursor = r.cursor
  }
  return { list: out.reverse(), from }
}

/** Everything the page shows, read in parallel. */
export async function readRecord(borrowerRef: string, account: string): Promise<Record> {
  const S = await loadSdk()
  const [c, w] = await Promise.all([credit(S, borrowerRef), wallet(S, account)])
  const refs = new Set([borrowerRef, ...c.loans.map((l) => l.ref), ...c.assets.map((a) => a.ref)])
  const ev = await events(S, refs).catch(() => ({ list: [] as ChainEvent[], from: null }))
  return { wallet: account, firstActivity: w.first, ajo: w.ajo, periods: w.periods, ...c, events: ev.list, eventsFrom: ev.from }
}

/** On time: within its round (no more than 1.5 rounds after her previous payment into the same ajo). */
export function ajoSummary(r: Pick<Record, 'ajo' | 'periods' | 'firstActivity'>, now = Date.now()) {
  let onTime = 0
  const last = new Map<number, number>()
  for (const p of [...r.ajo].sort((a, b) => a.at - b.at)) {
    const prev = last.get(p.group)
    const period = (r.periods.get(p.group) ?? 86_400) * 1000
    if (prev === undefined || p.at - prev <= period * 1.5) onTime++
    last.set(p.group, p.at)
  }
  const WEEK = 7 * 86_400_000
  const start = r.firstActivity ?? now
  const weeks = Math.max(1, Math.ceil((now - start) / WEEK))
  const weeksPaid = new Set(r.ajo.map((p) => Math.floor((p.at - start) / WEEK))).size
  return { payments: r.ajo.length, onTime, onTimePct: r.ajo.length ? Math.round((onTime * 100) / r.ajo.length) : null, weeks, weeksPaid }
}
