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
import { settle, useScreenTools } from '../plus/screen'
import { ENGLISH, LangContext } from '../plus/ui'
import { VoiceButton } from '../plus/voice'
import { Assets, requestPhoto } from './assets'
import { Receive, Scan } from './shop'
import { NgConfirmSheet } from './confirm'
import { AddCash, Ajo, CashOut, Home, Loan, Pay, Record, Savings, Settings, WalletDetail, type Detail } from './screens'
import { MIC_WORDS, naira, W, yo } from './words'

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

/** The screens the voice agent can open (navigate), by the names she would use. */
const VOICE_SCREENS: Record<string, { tab?: Tab; detail?: Detail }> = {
  home: { tab: 'home' },
  wallet: { detail: 'wallet' },
  add_money: { detail: 'add_cash' },
  pay: { tab: 'pay' },
  receive: { detail: 'receive' },
  my_code: { detail: 'receive' },
  scan: { detail: 'scan' },
  ajo: { detail: 'group' },
  savings: { detail: 'savings' },
  loan: { detail: 'loan' },
  assets: { detail: 'assets' },
  cash_out: { detail: 'cash_out' },
  activity: { tab: 'record' },
  profile: { tab: 'settings' },
}

type Tab = 'home' | 'pay' | 'record' | 'settings'
const TABS: Tab[] = ['home', 'pay', 'record', 'settings']
const DETAIL_TITLE: Record<Detail, [string, string | undefined]> = {
  wallet: [W.wallet.en, yo('wallet')],
  savings: [W.savings.en, yo('savings')],
  group: [W.ajo.en, yo('ajo')],
  loan: [W.loan.en, yo('loan')],
  assets: [W.assets.en, yo('assets')],
  add_cash: [W.addMoney.en, yo('addMoney')],
  cash_out: [W.cashOut.en, yo('cashOut')],
  receive: ['My code', undefined],
  scan: ['Scan to pay', undefined],
}

/** A Plus pay link opened from a shop's QR (plus-wallet.vercel.app/app/pay/<code>). */
const linkedCode = (() => {
  const m = window.location.pathname.match(/^\/app\/pay\/([A-Za-z0-9-]{6,7})\/?$/)
  return m ? m[1].toUpperCase().replace('-', '') : null
})()

export default function NgApp({ data }: { data: PlusData }) {
  useMarketAccent('ng')
  const [tab, setTab] = useState<Tab>('home')
  const [open, setOpen] = useState<Detail | null>(linkedCode ? 'scan' : null)
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
    } else if (s === 'group' || s === 'loan' || s === 'add_cash' || s === 'cash_out') {
      openDetail(s, false)
    }
  }, [openDetail])
  const props = { data, wallet, go, version: data.version }
  const onAnswer = (a: PendingAction) => setChosen(a)
  // A cash-out code made by voice is shown on the Cash out screen only (never handed to the agent).
  const [shownCode, setShownCode] = useState<{ id: string; code: string } | null>(null)

  // Every screen action, also by voice (ElevenLabs client tools; they run here, with her login).
  useScreenTools({
    navigate: async ({ screen }) => {
      const to = VOICE_SCREENS[String(screen ?? '').toLowerCase().replace(/[\s-]+/g, '_')]
      if (!to) return `There is no "${String(screen)}" screen. Screens: ${Object.keys(VOICE_SCREENS).join(', ')}.`
      if (to.tab) go(to.tab)
      else {
        setTab('home')
        openDetail(to.detail!, false)
      }
      await settle()
      return `Opened. Now tell her what is on her screen; what_is_on_screen describes it.`
    },
    new_cashout_code: async ({ amount }) => {
      openDetail('cash_out', false)
      const r = await tool('cash_outs')
      const open = ((r.cash_outs ?? []) as { id: string; amount: string; status: string; expires_at: string }[])
        .filter((c) => c.status === 'issued' && new Date(c.expires_at) > new Date())
      const want = amount !== undefined ? BigInt(Math.round(Number(amount))) * 100n : null
      const c = want !== null ? open.find((x) => BigInt(x.amount) === want) : open[0]
      if (!c) return open.length ? `No waiting cash-out of that amount. Waiting: ${open.map((x) => naira(x.amount)).join(', ')}.` : 'She has no cash-out waiting for an agent.'
      const n = await tool('new_cashout_code', { cash_out_id: c.id })
      if (!n.ok) return n.text
      setShownCode({ id: c.id, code: String(n.cash_out_code) })
      return `A new code for ${naira(c.amount)} is on her screen; the old one stopped working. Never read the code out loud.`
    },
    simulate_bank_transfer: async ({ amount }) => {
      openDetail('add_cash', false)
      const r = await tool('simulate_bank_transfer', { amount: String(amount ?? ''), sender: 'Chidi Okeke' })
      return r.text
    },
    take_photo: async ({ asset }) => {
      setTab('home')
      openDetail('assets', false)
      await settle()
      return await requestPhoto(asset === undefined ? undefined : String(asset))
    },
    sign_out: async () => {
      window.setTimeout(() => void supabase?.auth.signOut(), 1500)
      return 'Signing her out now. Say goodbye.'
    },
  })

  return (
    <LangContext.Provider value={ENGLISH}>
      <main className="mx-auto max-w-md px-4 pb-32 pt-[max(env(safe-area-inset-top),1.25rem)]">
        {tab === 'home' && <Home {...props} onAnswer={onAnswer} open={open} onOpen={(d) => openDetail(d)} />}
        {tab === 'pay' && <div className="space-y-5"><PageHeader title={W.pay.en} /><Pay {...props} onShop={(d) => openDetail(d, false)} /></div>}
        {tab === 'record' && <div className="space-y-5"><PageHeader title="Activity" /><Record {...props} /></div>}
        {tab === 'settings' && <div className="space-y-5"><PageHeader title="Profile" /><Settings {...props} onSignOut={() => void supabase?.auth.signOut()} /></div>}
      </main>

      <AnimatePresence>
        {open && (
          <CardDetail key={open} id={open} title={DETAIL_TITLE[open][0]} sub={DETAIL_TITLE[open][1]} fromPass={fromPass} onClose={() => setOpen(null)}>
            {open === 'wallet' && <WalletDetail wallet={wallet} version={data.version} onOpen={(d) => openDetail(d, false)} />}
            {open === 'savings' && <Savings {...props} />}
            {open === 'group' && <Ajo {...props} />}
            {open === 'loan' && <Loan {...props} />}
            {open === 'assets' && <Assets version={data.version} />}
            {open === 'add_cash' && <AddCash {...props} onAnswer={onAnswer} />}
            {open === 'receive' && <Receive version={data.version} />}
            {open === 'scan' && <Scan initialCode={linkedCode} />}
            {open === 'cash_out' && <CashOut {...props} shownCode={shownCode} onShowCode={setShownCode} />}
          </CardDetail>
        )}
      </AnimatePresence>

      <BottomNav<Tab>
        center={<VoiceButton size="dock" words={MIC_WORDS} />}
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
          lang={data.me?.language ?? 'en'}
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
