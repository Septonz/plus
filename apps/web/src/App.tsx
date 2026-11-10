// The overview (/): what Plus is, and the way into each page.
import { useState } from 'react'
import { MARKET_IDS, formatMoney, getMarket, type MarketId } from '@plus/markets'
import { Card, Icon, ListGroup, ListRow, Section, Segmented } from './ds/components'

const PAGES: [string, string, string, string][] = [
  ['/app', 'wallet', 'The Plus app', 'Funmi in Nigeria, Selvi in India'],
  ['/agent', 'cash', 'Cash agent', 'Mama Bisi at Bodija market'],
  ['/helper', 'person', 'Helper', 'Meena in Madurai'],
  ['/demo', 'activity', 'Demo view', 'Staff · projector'],
]

function App() {
  const [marketId, setMarketId] = useState<MarketId>('ng')
  const market = getMarket(marketId)

  return (
    <main className="mx-auto min-h-dvh max-w-md space-y-8 px-4 pb-16 pt-[max(env(safe-area-inset-top),3rem)]">
      <header className="space-y-2">
        <span className="grid size-12 place-items-center rounded-2xl bg-accent text-2xl text-on-accent shadow-lift"><Icon name="add" strokeWidth={2} /></span>
        <h1 className="pt-2 text-4xl font-semibold">Plus</h1>
        <p className="text-lg text-secondary">A voice-first wallet for people the financial system left behind. Stellar testnet; all money is simulated.</p>
      </header>

      <ListGroup>
        {PAGES.map(([href, icon, title, sub]) => (
          <li key={href}>
            <a href={href} className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors active:bg-fill">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-lg text-accent-ink"><Icon name={icon} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-lg font-medium">{title}</span>
                <span className="block text-sm text-secondary">{sub}</span>
              </span>
              <Icon name="chevron" className="text-lg text-secondary" />
            </a>
          </li>
        ))}
      </ListGroup>

      <Section title="Markets">
        <Segmented label="Market" value={marketId} onChange={setMarketId} options={MARKET_IDS.map((id) => [id, getMarket(id).country])} />
        <ListGroup>
          <ListRow title="Currency" trailing={<span className="text-base text-secondary">{market.currency.code} ({market.currency.symbol})</span>} />
          <ListRow title="Languages" trailing={<span className="text-base text-secondary">{market.languages.join(', ')}</span>} />
          <ListRow title="Group savings" trailing={<span className="text-base text-secondary">{market.groupSavings.localName}</span>} />
          <ListRow
            title="Advance"
            trailing={<span className="num text-base text-secondary">{formatMoney(BigInt(market.advance.min) * 100n, market.id)} to {formatMoney(BigInt(market.advance.max) * 100n, market.id)}</span>}
          />
        </ListGroup>
      </Section>

      <Card className="text-sm text-secondary">Prototype for the Stellar Blockchain Innovation Challenge. Fictional people; nothing here is real money.</Card>
    </main>
  )
}

export default App
