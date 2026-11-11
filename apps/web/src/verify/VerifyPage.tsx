// /verify (public, no login): a lender types the code Funmi gave them and sees her Plus record,
// read directly from Stellar. Plus's database only turns the code into her two public references;
// every line below comes from the chain and links to it. No name, phone, ID, photo or place.
import { formatTime } from '../lib/time'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Card, Icon, ListGroup, Notice, Section, Spinner } from '../ds/components'
import { supabase } from '../lib/supabase'
import {
  ASSET_LEVEL, ASSET_STATUS, CREDIT_CONTRACT, EXPLORER, LOAN_STATUS, PLUS_CONTRACT, ajoSummary, loadSdk, naira, readRecord,
  type Record as ChainRecord,
} from './stellar'

const ERRORS: Record<string, string> = {
  not_found: 'That code is not right. Check it with her and type it again.',
  expired: 'That code has expired (codes work for 24 hours). Ask her for a new one.',
  revoked: 'She revoked that code.',
  already_used: 'That code was already used by another lender. Ask her for a new one.',
  too_many_attempts: 'Too many wrong codes. Wait 10 minutes and try again.',
}

type Result = { rec: ChainRecord; ms: number; sharedAt: string; expiresAt: string }

export default function VerifyPage() {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code') ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [res, setRes] = useState<Result | null>(null)
  useEffect(() => { void loadSdk() }, [])

  async function verify(e?: FormEvent) {
    e?.preventDefault()
    if (!supabase) return setErr('This page is not configured.')
    setBusy(true)
    setErr(null)
    setRes(null)
    const t0 = performance.now()
    try {
      const { data, error } = await supabase.rpc('verify_record', { p_code: code })
      if (error) throw new Error(error.message)
      const r = data as { ok: boolean; error?: string; borrower_ref?: string; wallet?: string; shared_at?: string; expires_at?: string }
      if (!r.ok || !r.borrower_ref || !r.wallet) {
        setErr(ERRORS[r.error ?? ''] ?? "That code didn't work.")
        return
      }
      const rec = await readRecord(r.borrower_ref, r.wallet)
      setRes({ rec, ms: performance.now() - t0, sharedAt: r.shared_at!, expiresAt: r.expires_at! })
    } catch (x) {
      setErr(`Couldn't read Stellar just now (${x instanceof Error ? x.message : String(x)}). Try again.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto min-h-dvh max-w-xl space-y-6 px-4 pb-16 pt-[max(env(safe-area-inset-top),2.5rem)]">
      <header className="space-y-2">
        <a href="/" className="inline-flex items-center gap-2 text-sm font-medium text-secondary"><Icon name="add" /> Plus</a>
        <h1 className="text-3xl font-semibold">Verify a Plus record</h1>
        <p className="text-base text-secondary">For lenders. Type the code the borrower gave you. Everything you see is read directly from the Stellar network, not from Plus. Stellar testnet: a demo, all money is simulated.</p>
      </header>

      <Card>
        <form onSubmit={(e) => void verify(e)} className="space-y-3">
          <label className="block">
            <span className="text-base font-medium">Code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" maxLength={9} autoComplete="off" autoCapitalize="characters" spellCheck={false}
              className="num mt-1 min-h-12 w-full rounded-control bg-fill px-3 font-mono text-2xl tracking-[0.12em] text-label" aria-describedby="code-hint" />
          </label>
          <p id="code-hint" className="text-sm text-secondary">8 letters and numbers. It works for 24 hours, for one lender.</p>
          {err && <Notice tone="danger">{err}</Notice>}
          <Button type="submit" className="w-full" loading={busy} disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 8}>Verify</Button>
        </form>
      </Card>

      {busy && <p className="flex items-center gap-2 text-secondary" role="status"><Spinner /> Reading from Stellar…</p>}
      {res && <Summary r={res} />}
    </main>
  )
}

function Source({ href, children = 'Read from Stellar' }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-success hover:underline">
      <Icon name="verified" className="text-sm" /> {children}
    </a>
  )
}

function Line({ label, value, sub, href }: { label: string; value: ReactNode; sub?: ReactNode; href: string }) {
  return (
    <li className="space-y-1 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base text-secondary">{label}</span>
        <span className="text-right text-lg font-medium">{value}</span>
      </div>
      {sub && <p className="text-sm text-secondary">{sub}</p>}
      <Source href={href} />
    </li>
  )
}

const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

function Summary({ r }: { r: Result }) {
  const { rec } = r
  const ajo = ajoSummary(rec)
  const account = `${EXPLORER}/account/${rec.wallet}`
  const credit = `${EXPLORER}/contract/${CREDIT_CONTRACT}`
  const days = rec.firstActivity ? Math.max(0, Math.floor((Date.now() - rec.firstActivity) / 86_400_000)) : 0
  const months = Math.floor(days / 30)
  const history = rec.firstActivity ? (months >= 1 ? `${months} month${months === 1 ? '' : 's'}` : `${days} day${days === 1 ? '' : 's'}`) : 'none yet'
  const counted = rec.loans.filter((l) => l.status !== 5)
  const repaid = counted.filter((l) => l.status === 3).length
  const defaulted = counted.filter((l) => l.status === 4).length
  const cancelled = rec.loans.length - counted.length
  const open = rec.loans.find((l) => l.status <= 2)
  const verified = rec.assets.filter((a) => a.level > 0 && a.status === 0)
  const vouchedLoans = counted.filter((l) => l.vouchers.length > 0)

  return (
    <div className="space-y-6">
      <Notice tone="success">
        <span className="font-medium">Verified in {(r.ms / 1000).toFixed(1)} seconds</span>, read from Stellar. Shared with you {formatTime(r.sharedAt, { date: true, locale: 'en-GB' })}; the code stops working {formatTime(r.expiresAt, { date: true, locale: 'en-GB' })}.
      </Notice>

      <Section title="History">
        <ListGroup>
          <Line label="With Plus" value={history} sub={rec.firstActivity ? `First activity on her wallet: ${day(rec.firstActivity)}` : undefined} href={account} />
          <Line label="Ajo payments" value={ajo.payments} sub={ajo.payments ? `${ajo.onTime} of ${ajo.payments} on time (${ajo.onTimePct}%): each within its round` : 'None yet'} href={`${EXPLORER}/contract/${PLUS_CONTRACT}`} />
          <Line label="Saving" value={`${ajo.weeksPaid} of ${ajo.weeks} weeks`} sub="Weeks with at least one ajo payment" href={account} />
        </ListGroup>
      </Section>

      <Section title="Loans">
        <ListGroup>
          <Line label="Taken" value={counted.length} sub={`${repaid} repaid${defaulted ? `, ${defaulted} defaulted` : ''}${cancelled ? `; ${cancelled} closed by the demo reset (not counted)` : ''}`} href={credit} />
          <Line label="Now" value={open ? LOAN_STATUS[open.status] : 'No open loan'}
            sub={open ? `${naira(open.repaid)} repaid of ${naira(open.total)} (borrowed ${naira(open.principal)}, cost ${naira(open.cost)})${open.collateral ? `; secured by a verified asset (${open.collateral_pct}%)` : ''}${open.vouchers.length ? `; ${open.vouchers.length} ajo member${open.vouchers.length === 1 ? '' : 's'} vouched` : ''}` : undefined}
            href={credit} />
          {vouchedLoans.length > 0 && <Line label="Backed by ajo vouches" value={`${vouchedLoans.length} loan${vouchedLoans.length === 1 ? '' : 's'}`}
            sub={`${vouchedLoans.reduce((n, l) => n + l.vouchers.length, 0)} vouches from ajo members in good standing (verified ID, 6+ weeks, every ajo payment on time). Each voucher is a 32-byte reference.`} href={credit} />}
          {rec.vouches.length > 0 && <Line label="Vouches for her next loan" value={rec.vouches.length} sub={`Ajo members in good standing${rec.vouches.length >= 2 ? '; with two or more, a first loan needs 100% collateral instead of 150%' : ''}`} href={credit} />}
        </ListGroup>
      </Section>

      <Section title="Verified assets">
        {rec.assets.length === 0 ? <Card><p className="text-base text-secondary">None registered.</p></Card> : (
          <ListGroup>
            {rec.assets.map((a, i) => (
              <Line key={a.ref} label={`Asset ${i + 1}`} value={ASSET_LEVEL[a.level] ?? '?'}
                sub={`${ASSET_STATUS[a.status] ?? '?'}${a.pledged_to ? ' · secures a loan' : ''} · since ${day(a.registered_at * 1000)}`} href={credit} />
            ))}
          </ListGroup>
        )}
        <p className="px-1 text-sm text-secondary">{verified.length} verified and active. Photos and descriptions stay private with Plus; the chain holds a hash of the evidence.</p>
      </Section>

      {rec.events.length > 0 && (
        <Section title="Latest changes (contract events)">
          <ListGroup>
            {rec.events.slice(0, 8).map((e) => (
              <li key={`${e.tx}-${e.name}-${e.ref}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span><span className="block text-base">{e.name}</span><span className="block text-sm text-secondary">{formatTime(e.at, { date: true, locale: 'en-GB' })}</span></span>
                <Source href={`${EXPLORER}/tx/${e.tx}`}>Transaction</Source>
              </li>
            ))}
          </ListGroup>
        </Section>
      )}

      <p className="px-1 text-sm text-secondary">No name, phone number, ID, photo or place: on Stellar she is a wallet address and a 32-byte reference. Every share and every view is logged for her, and she can revoke this code.</p>
    </div>
  )
}
