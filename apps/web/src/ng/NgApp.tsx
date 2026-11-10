// Plus Nigeria (Funmi): her Stellar wallet is her account. Screens and wording come from the
// Nigeria market pack (getMarket('ng').screens). Big icons, simple English with Yoruba underneath,
// the mic on every screen, and the confirm sheet that opens by itself for actions she started.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getMarket, type Screen } from '@plus/markets'
import { supabase } from '../lib/supabase'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, PlusData } from '../plus/data'
import { ENGLISH, Icon, LangContext } from '../plus/ui'
import { VoiceButton } from '../plus/voice'
import { NgConfirmSheet } from './confirm'
import { AddCash, Advance, Ajo, CashOut, Home, Pay, Record, Settings } from './screens'
import { MIC_WORDS, Y, type WKey } from './words'

export type Wallet = { NGNT: bigint; USDC: bigint; updated_at: string | null }
export type Go = (s: Screen) => void

/** Wallet balances from the cache (wallet_balances), kept live through Realtime. */
function useWallet(userId: string | undefined, version: number): Wallet | null {
  const [w, setW] = useState<Wallet | null>(null)
  useEffect(() => {
    if (!supabase || !userId) return
    let live = true
    void supabase.from('wallet_balances').select('asset, amount, updated_at').eq('user_id', userId).then(({ data }) => {
      if (!live) return
      const rows = (data ?? []) as { asset: string; amount: number; updated_at: string }[]
      const get = (a: string) => BigInt(rows.find((r) => r.asset === a)?.amount ?? 0)
      setW({ NGNT: get('NGNT'), USDC: get('USDC'), updated_at: rows.map((r) => r.updated_at).sort().at(-1) ?? null })
    })
    return () => {
      live = false
    }
  }, [userId, version])
  return w
}

/** A read tool, refetched whenever her rows change. */
export function useTool(name: string, version: number) {
  const [r, setR] = useState<ToolResult | null>(null)
  useEffect(() => {
    let live = true
    void tool(name).then((x) => live && setR(x)).catch(() => live && setR({ text: '', error: 'network' }))
    return () => {
      live = false
    }
  }, [name, version])
  return r
}

const NAV_ICON: Partial<Record<Screen, [string, WKey]>> = {
  home: ['home', 'home'],
  pay: ['pay', 'pay'],
  group: ['group', 'ajo'],
  cash_out: ['hand', 'cashOut'],
  record: ['record', 'record'],
}

export default function NgApp({ data }: { data: PlusData }) {
  const screens = getMarket('ng').screens
  const [screen, setScreen] = useState<Screen>('home')
  const wallet = useWallet(data.me?.id, data.version)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [chosen, setChosen] = useState<PendingAction | null>(null)

  // Her own actions (voice or taps) open the sheet by themselves; an agent's cash-in waits on Home
  // until she taps it (chosen).
  const next = useMemo(() => data.pending.find((a) => a.created_by === 'user' && !dismissed.has(a.id)) ?? null, [data.pending, dismissed])
  const [held, setHeld] = useState<PendingAction | null>(null)
  if (!held && (chosen ?? next)) setHeld(chosen ?? next)

  const go = useCallback<Go>((s) => {
    setScreen(s)
    window.scrollTo({ top: 0 })
  }, [])
  const nav = screens.filter((s) => NAV_ICON[s]).slice(0, 5)
  const props = { data, wallet, go, version: data.version }

  return (
    <LangContext.Provider value={ENGLISH}>
      <div className="mx-auto max-w-md px-4 pb-44 pt-5">
        {screen === 'home' && <Home {...props} onAnswer={(a) => setChosen(a)} />}
        {screen === 'add_cash' && <AddCash {...props} onAnswer={(a) => setChosen(a)} />}
        {screen === 'pay' && <Pay {...props} />}
        {screen === 'group' && <Ajo {...props} />}
        {screen === 'advance' && <Advance {...props} />}
        {screen === 'cash_out' && <CashOut {...props} />}
        {screen === 'record' && <Record {...props} />}
        {screen === 'settings' && <Settings {...props} onSignOut={() => void supabase?.auth.signOut()} />}
      </div>

      {screen !== 'home' && (
        <div className="fixed bottom-28 right-4 z-30">
          <VoiceButton size="dock" words={MIC_WORDS} />
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-sand-deep bg-white pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto grid max-w-md" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
          {nav.map((s) => {
            const [icon, k] = NAV_ICON[s]!
            return (
              <li key={s}>
                <button
                  onClick={() => go(s)}
                  aria-current={screen === s ? 'page' : undefined}
                  className={`flex min-h-20 w-full flex-col items-center justify-start gap-1 px-1 pt-3 text-base font-bold leading-tight ${screen === s ? 'text-brick' : 'text-ink-soft'}`}
                >
                  <Icon name={icon} className="text-3xl" />
                  <Y k={k} className="text-center text-sm" sub="hidden" />
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {held && (
        <NgConfirmSheet
          key={held.id}
          action={held}
          txs={data.txs}
          onClose={() => {
            setDismissed((d) => new Set(d).add(held.id))
            setHeld(null)
            setChosen(null)
            void data.refresh()
          }}
        />
      )}
    </LangContext.Provider>
  )
}
