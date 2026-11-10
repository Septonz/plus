// Plus Nigeria (Funmi): her Stellar wallet is her account. Four tabs (Home, Pay, Activity,
// Profile); Home is a stack of passes that open full-screen; the mic floats bottom centre on every
// screen; the confirm sheet opens by itself for actions she started (by voice or taps).
import { AnimatePresence } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Screen } from '@plus/markets'
import { BottomNav, CardDetail, PageHeader, useMarketAccent } from '../ds/components'
import { supabase } from '../lib/supabase'
import { tool, type ToolResult } from '../plus/api'
import type { PendingAction, PlusData } from '../plus/data'
import { ENGLISH, LangContext } from '../plus/ui'
import { VoiceButton } from '../plus/voice'
import { NgConfirmSheet } from './confirm'
import { AddCash, Advance, Ajo, CashOut, Home, Pay, Record, Settings, WalletDetail, type Detail } from './screens'
import { MIC_WORDS, W, yo } from './words'

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

type Tab = 'home' | 'pay' | 'record' | 'settings'
const TABS: Tab[] = ['home', 'pay', 'record', 'settings']
const DETAIL_TITLE: Record<Detail, [string, string | undefined]> = {
  wallet: [W.wallet.en, yo('wallet')],
  group: [W.ajo.en, yo('ajo')],
  advance: [W.advance.en, yo('advance')],
  add_cash: [W.addMoney.en, yo('addMoney')],
  cash_out: [W.cashOut.en, yo('cashOut')],
}

export default function NgApp({ data }: { data: PlusData }) {
  useMarketAccent('ng')
  const [tab, setTab] = useState<Tab>('home')
  const [open, setOpen] = useState<Detail | null>(null)
  const [fromPass, setFromPass] = useState(true)
  const wallet = useWallet(data.me?.id, data.version)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [chosen, setChosen] = useState<PendingAction | null>(null)

  // Her own actions (voice or taps) open the sheet by themselves; an agent's cash-in waits on Home
  // until she taps it (chosen).
  const next = useMemo(() => data.pending.find((a) => a.created_by === 'user' && !dismissed.has(a.id)) ?? null, [data.pending, dismissed])
  const [held, setHeld] = useState<PendingAction | null>(null)
  if (!held && (chosen ?? next)) setHeld(chosen ?? next)

  const openDetail = useCallback((d: Detail, viaPass = true) => {
    setFromPass(viaPass)
    setOpen(d)
  }, [])
  const go = useCallback<Go>((s) => {
    if ((TABS as string[]).includes(s)) {
      setOpen(null)
      setTab(s as Tab)
      window.scrollTo({ top: 0 })
    } else if (s === 'group' || s === 'advance' || s === 'add_cash' || s === 'cash_out') {
      openDetail(s, false)
    }
  }, [openDetail])
  const props = { data, wallet, go, version: data.version }
  const onAnswer = (a: PendingAction) => setChosen(a)

  return (
    <LangContext.Provider value={ENGLISH}>
      <main className="mx-auto max-w-md px-4 pb-44 pt-[max(env(safe-area-inset-top),1.25rem)]">
        {tab === 'home' && <Home {...props} onAnswer={onAnswer} open={open} onOpen={(d) => openDetail(d)} />}
        {tab === 'pay' && <div className="space-y-5"><PageHeader title={W.pay.en} /><Pay {...props} /></div>}
        {tab === 'record' && <div className="space-y-5"><PageHeader title="Activity" /><Record {...props} /></div>}
        {tab === 'settings' && <div className="space-y-5"><PageHeader title="Profile" /><Settings {...props} onSignOut={() => void supabase?.auth.signOut()} /></div>}
      </main>

      <AnimatePresence>
        {open && (
          <CardDetail key={open} id={open} title={DETAIL_TITLE[open][0]} sub={DETAIL_TITLE[open][1]} fromPass={fromPass} onClose={() => setOpen(null)}>
            {open === 'wallet' && <WalletDetail wallet={wallet} version={data.version} onOpen={(d) => openDetail(d, false)} />}
            {open === 'group' && <Ajo {...props} />}
            {open === 'advance' && <Advance {...props} />}
            {open === 'add_cash' && <AddCash {...props} onAnswer={onAnswer} />}
            {open === 'cash_out' && <CashOut {...props} />}
          </CardDetail>
        )}
      </AnimatePresence>

      <VoiceButton words={MIC_WORDS} />

      <BottomNav<Tab>
        active={open ? null : tab}
        onSelect={(k) => go(k)}
        items={[
          { key: 'home', label: W.home.en, icon: 'home' },
          { key: 'pay', label: W.pay.en, icon: 'pay' },
          { key: 'record', label: 'Activity', icon: 'activity' },
          { key: 'settings', label: 'Profile', icon: 'profile' },
        ]}
      />

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
