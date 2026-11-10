// The Plus app (/app): Selvi's home. A big mic on every screen, a bottom bar, and the confirm
// screen that opens by itself when a pending action she started arrives through Realtime.
import { ConversationProvider } from '@elevenlabs/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEMO_AS, DEMO_FUNMI_EMAIL, DEMO_SELVI_EMAIL, supabase } from '../lib/supabase'
import { AutoSignIn, DemoChoice, useSession } from './auth'
import { ConfirmSheet } from './confirm'
import { tool } from './api'
import { usePlusData, type PendingAction } from './data'
import type { Lang } from './i18n'
import { AddMoney, Advance, Home, Pay, Record, Seettu, Settings, type Screen } from './screens'
import { Icon, L, LangContext, Notice, useLang as useLangContext } from './ui'
import { VoiceButton } from './voice'

const LANG_KEY = 'plus-lang'
// Nigeria (the launch market) has its own screens, chosen from the user's market pack.
const NgApp = lazy(() => import('../ng/NgApp.tsx'))

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
      <div className="min-h-dvh bg-cream text-ink">
        {!ready ? null : session ? (
          <ConversationProvider>
            <Signed authUserId={session.user.id} />
          </ConversationProvider>
        ) : DEMO_AS ? (
          <AutoSignIn email={DEMO_AS === 'funmi' ? DEMO_FUNMI_EMAIL : DEMO_SELVI_EMAIL} name={DEMO_AS === 'funmi' ? 'Funmi' : 'Selvi'} />
        ) : (
          <DemoChoice
            people={[
              { email: DEMO_FUNMI_EMAIL, label: 'Continue as Funmi', note: 'Nigeria · tomato seller, Ibadan · wallet on Stellar' },
              { email: DEMO_SELVI_EMAIL, label: 'Continue as Selvi', note: 'India · flower seller, Madurai · bank account' },
            ]}
          />
        )}
      </div>
    </LangContext.Provider>
  )
}

function Signed({ authUserId }: { authUserId: string }) {
  const data = usePlusData(authUserId)
  const [screen, setScreen] = useState<Screen>('home')
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const { lang, setLang } = useLangSync(data.me?.language)

  // Open the confirm screen for the newest action she started (voice or taps). Cash-ins from a
  // helper show on Home instead, so she is not interrupted by someone else's action. The sheet
  // keeps its action after it executes (Realtime drops it from pending) so she sees "Done".
  const next = useMemo(
    () => data.pending.find((a) => a.created_by === 'user' && !dismissed.has(a.id)) ?? null,
    [data.pending, dismissed],
  )
  const [held, setHeld] = useState<PendingAction | null>(null)
  if (next && !held) setHeld(next)
  const open = held

  const go = (s: Screen) => {
    setScreen(s)
    window.scrollTo({ top: 0 })
  }
  const signOut = async () => {
    await supabase?.auth.signOut()
  }

  if (data.loading) return <p className="py-20 text-center text-2xl">…</p>
  if (data.error === 'no_plus_account') return <div className="p-6"><Notice tone="chili">This login is not linked to a Plus account. Run pnpm seed:db.</Notice></div>
  if (data.me?.market_id === 'ng') {
    return (
      <Suspense fallback={<p className="py-20 text-center text-2xl">…</p>}>
        <NgApp data={data} />
      </Suspense>
    )
  }

  const nav: [Screen, string, 'home' | 'pay' | 'seettu' | 'record' | 'settings'][] = [
    ['home', 'home', 'home'],
    ['pay', 'pay', 'pay'],
    ['seettu', 'group', 'seettu'],
    ['record', 'record', 'record'],
    ['settings', 'settings', 'settings'],
  ]

  return (
    <>
      <div className="mx-auto max-w-md px-4 pb-44 pt-5">
        <div className="mb-3 flex justify-end">
          <button
            onClick={() => {
              const next = lang === 'ta' ? 'en' : 'ta'
              setLang(next)
              void tool('update_settings', { language: next }).catch(() => null)
            }}
            className="min-h-11 rounded-full border-2 border-sand-deep bg-white px-4 text-base font-bold"
            aria-label="Language / மொழி"
          >
            {lang === 'ta' ? 'English' : 'தமிழ்'}
          </button>
        </div>
        {data.error && data.error !== 'no_plus_account' && <Notice tone="chili">{data.error}</Notice>}
        {screen === 'home' && <Home data={data} go={go} />}
        {screen === 'pay' && <Pay data={data} go={go} />}
        {screen === 'seettu' && <Seettu data={data} go={go} />}
        {screen === 'advance' && <Advance data={data} go={go} />}
        {screen === 'record' && <Record data={data} go={go} />}
        {screen === 'add' && <AddMoney data={data} go={go} />}
        {screen === 'settings' && <Settings data={data} go={go} onSignOut={signOut} />}
      </div>

      {/* Mic on every screen: the hero mic lives on Home, a docked one everywhere else. */}
      {screen !== 'home' && screen !== 'pay' && (
        <div className="fixed bottom-28 right-4 z-30">
          <VoiceButton size="dock" />
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-sand-deep bg-white pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {nav.map(([s, icon, k]) => (
            <li key={s}>
              <button
                onClick={() => go(s)}
                aria-current={screen === s ? 'page' : undefined}
                className={`flex min-h-20 w-full flex-col items-center justify-center gap-1 px-1 text-base font-bold ${screen === s ? 'text-brick' : 'text-ink-soft'}`}
              >
                <Icon name={icon} className="text-2xl" />
                <span className="text-center leading-tight">{lang === 'ta' ? <L k={k} sub="hidden" /> : <L k={k} />}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {open && (
        <ConfirmSheet
          key={open.id}
          action={open}
          onClose={() => {
            setDismissed((d) => new Set(d).add(open.id))
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
