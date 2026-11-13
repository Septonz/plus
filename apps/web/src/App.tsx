// The landing page (/), piece 12: anyone with the link can try the whole app with no setup.
// Order: Try Plus now (a guest trader of their own), the 2-minute test, Try the agent app (a guest
// agent), Verify a record (lenders), Watch the demo (video), then a small Presenters link (the demo
// logins and /demo, still behind DEMO_LOGINS_ENABLED on the server).
import { useState } from 'react'
import { MARKET_IDS, formatMoney, getMarket, type MarketId } from '@plus/markets'
import { Button, Card, Icon, ListGroup, ListRow, Notice, Section, Segmented } from './ds/components'
import { GUEST_STEPS, startGuest } from './lib/guest'
import { DEMO_VIDEO_URL } from './lib/presenter'

function Row({ href, icon, title, sub, onClick, busy }: { href?: string; icon: string; title: string; sub: string; onClick?: () => void; busy?: boolean }) {
  const inner = (
    <>
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-lg text-accent-ink"><Icon name={icon} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-lg font-medium">{title}</span>
        <span className="block text-sm text-secondary">{sub}</span>
      </span>
      <Icon name={busy ? 'refresh' : 'chevron'} className={`text-lg text-secondary ${busy ? 'animate-spin' : ''}`} />
    </>
  )
  const cls = 'flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-fill disabled:opacity-60'
  return <li>{href ? <a href={href} className={cls} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{inner}</a> : <button onClick={onClick} disabled={busy} className={cls}>{inner}</button>}</li>
}

function App() {
  const [marketId, setMarketId] = useState<MarketId>('ng')
  const market = getMarket(marketId)
  const [busy, setBusy] = useState<'trader' | 'agent' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function tryIt(kind: 'trader' | 'agent') {
    setBusy(kind)
    setError(null)
    const err = await startGuest(kind)
    if (err) {
      setBusy(null)
      return setError(err)
    }
    window.location.assign(kind === 'trader' ? '/app' : '/agent')
  }

  return (
    <main className="mx-auto min-h-dvh max-w-md space-y-8 px-4 pb-16 pt-[max(env(safe-area-inset-top),3rem)]">
      <header className="space-y-2">
        <span className="grid size-12 place-items-center rounded-2xl bg-accent text-2xl text-on-accent shadow-lift"><Icon name="add" strokeWidth={2} /></span>
        <h1 className="pt-2 text-4xl font-semibold">Plus</h1>
        <p className="text-lg text-secondary">A voice-first wallet for market traders: pay, save, join an ajo and borrow fairly, on Stellar.</p>
      </header>

      <div className="space-y-3">
        <Button className="w-full" loading={busy === 'trader'} disabled={busy !== null} onClick={() => void tryIt('trader')}>Try Plus now</Button>
        <p className="text-center text-sm text-secondary">You get a test market trader of your own, with 8 weeks of history. No sign-up.</p>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>

      <Section title="Test it in 2 minutes">
        <Card>
          <ol className="space-y-3">
            {GUEST_STEPS.map((s, i) => (
              <li key={s.key} className="flex gap-3">
                <span className="num grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-ink">{i + 1}</span>
                <span className="min-w-0">
                  <span className="block text-base font-medium leading-snug">{s.title}</span>
                  <span className="block text-sm text-secondary">{s.how}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-sm text-secondary">
            Every action is a real Stellar testnet transaction. Tap any “Verified on Stellar” tick to see it on the explorer. No real money.
          </p>
        </Card>
      </Section>

      <ListGroup>
        <Row icon="cash" title="Try the agent app" sub="Be a cash agent: record cash in, pay out codes" busy={busy === 'agent'} onClick={() => void tryIt('agent')} />
        <Row href="/verify" icon="shield" title="Verify a record" sub="For lenders: read a trader’s record from Stellar" />
        {DEMO_VIDEO_URL && <Row href={DEMO_VIDEO_URL} icon="play" title="Watch the demo" sub="Plus used by voice, in 60 seconds" />}
      </ListGroup>

      <Section title="Markets">
        <Segmented label="Market" value={marketId} onChange={setMarketId} options={MARKET_IDS.map((id) => [id, getMarket(id).country])} />
        <ListGroup>
          <ListRow title="Currency" trailing={<span className="text-base text-secondary">{market.currency.code} ({market.currency.symbol})</span>} />
          <ListRow title="Languages" trailing={<span className="text-base text-secondary">{market.spokenLanguages.join(', ')}</span>} />
          <ListRow title="Group savings" trailing={<span className="text-base text-secondary">{market.groupSavings.localName}</span>} />
          {market.lending ? (
            <ListRow
              title="Loans"
              trailing={<span className="num text-base text-secondary">{formatMoney(BigInt(market.lending.ladder[0].max) * 100n, market.id)} → {formatMoney(BigInt(Math.max(...market.lending.ladder.map((s) => s.max))) * 100n, market.id)}, from {market.lending.ladder[0].costBps / 100}%</span>}
            />
          ) : (
            <ListRow
              title="Advance"
              trailing={<span className="num text-base text-secondary">{formatMoney(BigInt(market.advance.min) * 100n, market.id)} to {formatMoney(BigInt(market.advance.max) * 100n, market.id)}</span>}
            />
          )}
        </ListGroup>
      </Section>

      <Card className="text-sm text-secondary">Prototype for the Stellar Blockchain Innovation Challenge. Fictional people; nothing here is real money.</Card>

      <p className="text-center text-sm">
        <a href="/app" className="inline-flex min-h-11 items-center px-3 text-tertiary">Presenters</a>
        <span className="text-tertiary" aria-hidden="true">·</span>
        <a href="/demo" className="inline-flex min-h-11 items-center px-3 text-tertiary">Demo view</a>
      </p>
    </main>
  )
}

export default App
