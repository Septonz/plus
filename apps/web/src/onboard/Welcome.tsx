// The /app front door: open a new account (sign-up by voice or taps), sign in with phone + PIN,
// or (demo) continue as one of the demo people.
import { ConversationProvider } from '@elevenlabs/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { DEMO_FUNMI_EMAIL, DEMO_PASSWORD, DEMO_SELVI_EMAIL, supabase } from '../lib/supabase'
import { tool } from '../plus/api'
import { BigButton, ENGLISH, Icon, LangContext, Notice, Spinner } from '../plus/ui'
import { Y } from '../ng/words'
import { ArtWelcome } from './art'

const Onboarding = lazy(() => import('./Onboarding.tsx'))
const SignIn = lazy(() => import('./Onboarding.tsx').then((m) => ({ default: m.SignIn })))

const DEMO = [
  { email: DEMO_FUNMI_EMAIL, label: 'Funmi', note: 'Nigeria · tomato seller, Ibadan · wallet on Stellar' },
  { email: DEMO_SELVI_EMAIL, label: 'Selvi', note: 'India · flower seller, Madurai · bank account' },
]

const Loading = () => (
  <div className="grid min-h-dvh place-items-center text-4xl text-brick" role="status" aria-label="Loading"><Spinner /></div>
)

export default function Welcome() {
  return (
    <LangContext.Provider value={ENGLISH}>
      <Door />
    </LangContext.Provider>
  )
}

function Door() {
  const [view, setView] = useState<'home' | 'signup' | 'signin'>(() => (new URLSearchParams(window.location.search).get('signup') ? 'signup' : 'home'))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The backend switch (DEMO_LOGINS_ENABLED): when it is off, the demo people are not offered.
  const [demoOn, setDemoOn] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void tool<{ enabled?: boolean }>('demo_logins').then((r) => live && setDemoOn(r.enabled !== false)).catch(() => live && setDemoOn(true))
    return () => {
      live = false
    }
  }, [])

  if (view === 'signup') {
    // The mic needs the voice SDK's provider (sign-up by voice).
    return (
      <ConversationProvider>
        <Suspense fallback={<Loading />}><Onboarding mode="app" onExit={() => setView('home')} /></Suspense>
      </ConversationProvider>
    )
  }
  if (view === 'signin') return <Suspense fallback={<Loading />}><SignIn onBack={() => setView('home')} /></Suspense>

  async function demo(email: string) {
    if (!supabase) return setError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the repo-root .env.local.')
    if (!DEMO_PASSWORD) return setError('Run `pnpm seed:db` to create the demo logins (it writes VITE_DEMO_LOGIN_PASSWORD).')
    setBusy(email)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD })
    setBusy(null)
    if (error) setError(error.message)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 pb-10 pt-8">
      <div className="text-center">
        <img src="/icons/icon-192.png" alt="" className="mx-auto size-20 rounded-[1.5rem] shadow-lift" />
        <h1 className="mt-3 text-5xl font-extrabold text-brick">Plus</h1>
        <p className="mt-1 text-2xl font-bold">Your money, by voice</p>
      </div>
      <ArtWelcome />
      <BigButton className="min-h-20 w-full text-2xl" onClick={() => setView('signup')}>
        <Icon name="userPlus" /> <Y k="openAccount" sub="text-cream/80" />
      </BigButton>
      <BigButton tone="white" className="w-full" onClick={() => setView('signin')}>
        <Icon name="lock" /> <Y k="haveAccount" />
      </BigButton>

      {demoOn !== false && <section className="mt-2 space-y-3" aria-labelledby="demo-people">
        <h2 id="demo-people" className="flex items-center gap-3 text-base font-bold uppercase tracking-wide text-ink-soft">
          <span className="h-0.5 flex-1 bg-line" /> Demo people <span className="h-0.5 flex-1 bg-line" />
        </h2>
        {DEMO.map((p) => (
          <button
            key={p.email}
            onClick={() => void demo(p.email)}
            disabled={busy !== null}
            className="flex min-h-16 w-full items-center gap-3 rounded-control bg-white px-4 py-3 text-left shadow-card active:bg-sand disabled:opacity-60"
          >
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-sand text-2xl text-brick">
              {busy === p.email ? <Spinner /> : <Icon name="person" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xl font-bold">Continue as {p.label}</span>
              <span className="block text-base text-ink-soft">{p.note}</span>
            </span>
          </button>
        ))}
        {error && <Notice tone="chili">{error}</Notice>}
        <p className="text-center text-base text-ink-soft">Stellar testnet. All money is simulated.</p>
      </section>}
    </main>
  )
}
