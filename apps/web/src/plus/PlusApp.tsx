// The Plus app (/app): Selvi's home. A big mic on every screen, a bottom bar, and the confirm
// screen that opens by itself when a pending action she started arrives through Realtime.
import { ConversationProvider } from '@elevenlabs/react'
import { AnimatePresence } from 'motion/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BottomNav, CardDetail, PageHeader, useMarketAccent } from '../ds/components'
import { DEMO_AS, DEMO_FUNMI_EMAIL, DEMO_SELVI_EMAIL, supabase } from '../lib/supabase'
import { AutoSignIn, useSession } from './auth'
import { ConfirmSheet } from './confirm'
import { usePlusData, type PendingAction } from './data'
import { T, type Key, type Lang } from './i18n'
import { AddMoney, Advance, Home, Pay, Record, Savings, Seettu, Settings, type Detail, type Screen } from './screens'
import { call, newKey, tool, type ToolResult } from './api'
import { settle, useScreenTools } from './screen'
import { LangContext, Notice, Spinner, useLang as useLangContext } from './ui'
import { VoiceButton } from './voice'

const LANG_KEY = 'plus-lang'
// Nigeria (the launch market) has its own screens, chosen from the user's market pack.
const NgApp = lazy(() => import('../ng/NgApp.tsx'))
// The front door when nobody is signed in: open an account, sign in with phone + PIN, or a demo person.
const Welcome = lazy(() => import('../onboard/Welcome.tsx'))

const Loading = () => (
  <div className="grid min-h-dvh place-items-center text-3xl text-secondary" role="status" aria-label="Loading">
    <Spinner />
  </div>
)

function readLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ta'
  } catch {
    return 'ta'
  }
}

export default function PlusApp() {
  const [lang, setLangState] = useState<Lang>(readLang)
  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      localStorage.setItem(LANG_KEY, l)
    } catch {
      // private mode: keep it for this visit only
    }
  }, [])
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  const { session, ready } = useSession()

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <div className="min-h-dvh bg-canvas text-label">
        {!ready ? null : session ? (
          <ConversationProvider>
            <Signed authUserId={session.user.id} />
          </ConversationProvider>
        ) : DEMO_AS ? (
          <AutoSignIn email={DEMO_AS === 'funmi' ? DEMO_FUNMI_EMAIL : DEMO_SELVI_EMAIL} name={DEMO_AS === 'funmi' ? 'Funmi' : 'Selvi'} />
        ) : (
          <Suspense fallback={<Loading />}>
            <Welcome />
          </Suspense>
        )}
      </div>
    </LangContext.Provider>
  )
}

type Tab = 'home' | 'pay' | 'record' | 'settings'
const TABS: Tab[] = ['home', 'pay', 'record', 'settings']
/** The screens the voice agent can open (navigate), by the names she would use. */
const VOICE_SCREENS: Record<string, Screen> = {
  home: 'home', money: 'add', add_money: 'add', savings: 'savings', seettu: 'seettu', advance: 'advance',
  pay: 'pay', activity: 'record', record: 'record', profile: 'settings', settings: 'settings',
}
const DETAIL_KEY: Record<Detail, Key> = { add: 'toSpend', savings: 'savings', seettu: 'seettu', advance: 'advance' }

function Signed({ authUserId }: { authUserId: string }) {
  const data = usePlusData(authUserId)
  const [tab, setTab] = useState<Tab>('home')
  const [open, setOpen] = useState<Detail | null>(null)
  const [fromPass, setFromPass] = useState(true)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const { lang } = useLangSync(data.me?.language)
  useMarketAccent(data.me?.market_id === 'ng' ? undefined : data.me ? 'in' : undefined)

  // Open the confirm sheet for the newest action she started (voice or taps). Cash-ins from a
  // helper show on Home instead, so she is not interrupted by someone else's action. The sheet
  // keeps its action after it executes (Realtime drops it from pending) so she sees "Done".
  const next = useMemo(
    () => data.pending.find((a) => a.created_by === 'user' && !dismissed.has(a.id)) ?? null,
    [data.pending, dismissed],
  )
  const [held, setHeld] = useState<PendingAction | null>(null)
  if (next && !held) setHeld(next)
  const confirm = held

  const openDetail = useCallback((d: Detail, viaPass = true) => {
    setFromPass(viaPass)
    setOpen(d)
  }, [])
  const go = useCallback((s: Screen) => {
    if ((TABS as string[]).includes(s)) {
      setOpen(null)
      setTab(s as Tab)
      window.scrollTo({ top: 0 })
    } else if (s === 'add' || s === 'savings' || s === 'seettu' || s === 'advance') {
      openDetail(s, false)
    }
  }, [openDetail])
  const signOut = async () => {
    await supabase?.auth.signOut()
  }
  const { setLang } = useLangContext()

  // Every screen action, also by voice (ElevenLabs client tools; they run here, with her login).
  // Nigeria registers its own in NgApp: none of these for a Nigeria user.
  useScreenTools(data.me?.market_id !== 'in' ? {} : {
    navigate: async ({ screen }) => {
      const to = VOICE_SCREENS[String(screen ?? '').toLowerCase().replace(/[\s-]+/g, '_')]
      if (!to) return `There is no "${String(screen)}" screen. Screens: ${Object.keys(VOICE_SCREENS).join(', ')}.`
      if (!(TABS as string[]).includes(to)) setTab('home')
      go(to)
      await settle()
      return 'Opened. Now tell her what is on her screen; what_is_on_screen describes it.'
    },
    set_language: async ({ language }) => {
      const l = String(language ?? '').toLowerCase().startsWith('t') ? 'ta' : String(language ?? '').toLowerCase().startsWith('e') ? 'en' : null
      if (!l) return 'Tamil or English?'
      setLang(l)
      const r = await tool('update_settings', { language: l })
      return r.ok ? `The app is now in ${l === 'ta' ? 'Tamil' : 'English'}.` : r.text
    },
    update_trusted_contact: async ({ phone }) => {
      const r = await tool('update_settings', { trusted_contact_phone: String(phone ?? '') })
      if (r.ok) void data.refresh()
      return r.ok ? 'Saved her trusted person.' : r.error === 'invalid_phone' ? 'That is not a 10-digit mobile number. Ask again.' : r.text
    },
    simulate_money_in: async ({ kind, amount }) => {
      openDetail('add', false)
      const wages = String(kind ?? '').startsWith('wage')
      const r = await call<ToolResult>(`payout-sim/${wages ? 'wages_arrive' : 'state_transfer_arrives'}`, {
        idempotency_key: newKey('voice'),
        ...(wages ? { amount: Number(amount ?? 0) } : {}),
      }).catch(() => ({ text: 'No connection.', ok: false }) as ToolResult)
      void data.refresh()
      return r.ok ? `${r.text} To spend: ${String(r.balance_text)}; saved: ${String(r.savings_text)}.` : r.text || String(r.error)
    },
    sign_out: async () => {
      window.setTimeout(() => void signOut(), 1500)
      return 'Signing her out now. Say goodbye.'
    },
  })

  if (data.loading) return <Loading />
  if (data.error === 'no_plus_account') {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <Notice tone="chili">This login is not linked to a Plus account.</Notice>
        <button onClick={() => void signOut()} className="min-h-12 w-full rounded-full bg-fill text-lg font-semibold">Sign out</button>
      </div>
    )
  }
  if (data.me?.market_id === 'ng') {
    return (
      <Suspense fallback={<Loading />}>
        <NgApp data={data} />
      </Suspense>
    )
  }

  const ta = lang === 'ta'
  const head = (k: Key) => <PageHeader title={T[k].en} sub={ta ? T[k].ta : undefined} />
  const props = { data, go }

  return (
    <>
      <main className="mx-auto max-w-md px-4 pb-44 pt-[max(env(safe-area-inset-top),1.25rem)]">
        {data.error && data.error !== 'no_plus_account' && <div className="mb-4"><Notice tone="chili">{data.error}</Notice></div>}
        {tab === 'home' && <Home {...props} open={open} onOpen={(d) => openDetail(d)} />}
        {tab === 'pay' && <div className="space-y-5">{head('pay')}<Pay {...props} /></div>}
        {tab === 'record' && <div className="space-y-5">{head('activity')}<Record {...props} /></div>}
        {tab === 'settings' && <div className="space-y-5">{head('profile')}<Settings {...props} onSignOut={() => void signOut()} /></div>}
      </main>

      <AnimatePresence>
        {open && (
          <CardDetail key={open} id={open} title={T[DETAIL_KEY[open]].en} sub={ta ? T[DETAIL_KEY[open]].ta : undefined} fromPass={fromPass} onClose={() => setOpen(null)}>
            {open === 'add' && <AddMoney {...props} />}
            {open === 'savings' && <Savings {...props} />}
            {open === 'seettu' && <Seettu {...props} />}
            {open === 'advance' && <Advance {...props} />}
          </CardDetail>
        )}
      </AnimatePresence>

      <VoiceButton />

      <BottomNav<Tab>
        active={open ? null : tab}
        onSelect={(k) => go(k)}
        items={[
          { key: 'home', label: T.home.en, icon: 'home', aria: ta ? `${T.home.en} · ${T.home.ta}` : undefined },
          { key: 'pay', label: T.pay.en, icon: 'pay', aria: ta ? `${T.pay.en} · ${T.pay.ta}` : undefined },
          { key: 'record', label: T.activity.en, icon: 'activity', aria: ta ? `${T.activity.en} · ${T.activity.ta}` : undefined },
          { key: 'settings', label: T.profile.en, icon: 'profile', aria: ta ? `${T.profile.en} · ${T.profile.ta}` : undefined },
        ]}
      />

      {confirm && (
        <ConfirmSheet
          key={confirm.id}
          action={confirm}
          onClose={() => {
            setDismissed((d) => new Set(d).add(confirm.id))
            setHeld(null)
            void data.refresh()
          }}
        />
      )}
    </>
  )
}

/** Follow her saved language once it loads, unless she already chose one on this device. */
function useLangSync(saved: string | undefined) {
  const ctx = useLangContext()
  const synced = useRef(false)
  const { setLang } = ctx
  useEffect(() => {
    if (synced.current || !saved) return
    synced.current = true
    let stored: string | null = null
    try {
      stored = localStorage.getItem(LANG_KEY)
    } catch {
      // ignore
    }
    if (!stored && (saved === 'en' || saved === 'ta')) setLang(saved)
  }, [saved, setLang])
  return ctx
}
