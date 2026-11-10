import { useState } from 'react'
import { MARKET_IDS, formatMoney, getMarket, type MarketId } from '@plus/markets'

function App() {
  const [marketId, setMarketId] = useState<MarketId>('in')
  const market = getMarket(marketId)

  return (
    <main className="min-h-screen bg-stone-50 text-stone-900 flex flex-col items-center justify-center gap-8 p-6">
      <h1 className="text-6xl font-bold tracking-tight">Plus</h1>

      <div className="flex flex-wrap justify-center gap-3">
        <a href="/app" className="rounded-full bg-[#7a2e14] px-6 py-3 text-lg font-bold text-white">Open the Plus app</a>
        <a href="/helper" className="rounded-full border-2 border-stone-300 bg-white px-6 py-3 text-lg font-bold">Helper page</a>
        <a href="/agent" className="rounded-full border-2 border-stone-300 bg-white px-6 py-3 text-lg font-bold">Agent page</a>
        <a href="/demo" className="rounded-full border-2 border-stone-300 bg-white px-6 py-3 text-lg font-bold">Demo view (staff)</a>
      </div>

      <div role="radiogroup" aria-label="Market" className="inline-flex rounded-full bg-stone-200 p-1">
        {MARKET_IDS.map((id) => {
          const selected = id === marketId
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setMarketId(id)}
              className={`rounded-full px-5 py-2 text-sm font-medium transition ${
                selected ? 'bg-white shadow text-stone-900' : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              {getMarket(id).country}
            </button>
          )
        })}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-stone-500">Currency</dt>
        <dd>
          {market.currency.code} ({market.currency.symbol})
        </dd>
        <dt className="text-stone-500">Languages</dt>
        <dd>{market.languages.join(', ')}</dd>
        <dt className="text-stone-500">Group savings</dt>
        <dd>{market.groupSavings.localName}</dd>
        <dt className="text-stone-500">Advance</dt>
        <dd>
          {formatMoney(BigInt(market.advance.min) * 100n, market.id)} to{' '}
          {formatMoney(BigInt(market.advance.max) * 100n, market.id)}
        </dd>
      </dl>
    </main>
  )
}

export default App
