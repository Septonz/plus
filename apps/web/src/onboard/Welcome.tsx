// The /app front door: open a new account (sign-up by voice or taps), sign in with phone + PIN,
// or (demo) continue as one of the demo people. A quiet hero: the wordmark, one line of purpose and
// a wallet card drawn in CSS (no illustrations).
import { ConversationProvider } from '@elevenlabs/react'
import { motion } from 'motion/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Button, Icon, ListGroup, Notice, Section, Spinner, softSpring } from '../ds/components'
import { DEMO_FUNMI_EMAIL, DEMO_AMAKA_EMAIL, DEMO_KEMI_EMAIL, DEMO_PASSWORD, DEMO_SELVI_EMAIL, supabase } from '../lib/supabase'
import { tool } from '../plus/api'
import { ENGLISH, LangContext } from '../plus/ui'
import { W } from '../ng/words'

const Onboarding = lazy(() => import('./Onboarding.tsx'))
const SignIn = lazy(() => import('./Onboarding.tsx').then((m) => ({ default: m.SignIn })))

const DEMO = [
  { email: DEMO_FUNMI_EMAIL, label: 'Funmi', note: 'Nigeria · tomato seller in Ibadan · loan offer' },
  { email: DEMO_KEMI_EMAIL, label: 'Kemi', note: 'Nigeria · new to Plus, week 4 of 6' },
  { email: DEMO_AMAKA_EMAIL, label: 'Amaka', note: 'Nigeria · confirms Kemi’s asset as a witness' },
  { email: DEMO_SELVI_EMAIL, label: 'Selvi', note: 'India · flower seller in Madurai' },
]

const Loading = () => (
  <div className="grid min-h-dvh place-items-center text-3xl text-secondary" role="status" aria-label="Loading"><Spinner /></div>
)

export default function Welcome() {
  return (
    <LangContext.Provider value={ENGLISH}>
      <Door />
    </LangContext.Provider>
  )
}

/** The wallet card, drawn in CSS only: the market gradient, a soft glow, the wordmark. */
function WalletCard() {
  return (
    <motion.div
      initial={{ y: 16, opacity: 0, rotate: -2 }}
      animate={{ y: 0, opacity: 1, rotate: -2 }}
      transition={softSpring}
      aria-hidden="true"
      className="relative mx-auto aspect-[1.586] w-full max-w-[20rem] overflow-hidden rounded-card p-5 text-white shadow-lift"
      style={{ background: 'var(--wallet)' }}
    >
      <span className="absolute -right-12 -top-16 size-48 rounded-full bg-white/10 blur-2xl" />
      <span className="absolute -bottom-20 -left-10 size-48 rounded-full bg-black/10 blur-2xl" />
      <span className="relative flex h-full flex-col justify-between">
        <span className="flex items-center justify-between">
          <span className="text-lg font-semibold tracking-tight">Plus</span>
          <Icon name="wallet" className="text-xl text-white/70" />
        </span>
        <span>
          <span className="block text-sm text-white/70">Wallet</span>
          <span className="num block text-4xl font-light">₦26,400</span>
        </span>
      </span>
    </motion.div>
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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-4 pb-10 pt-[max(env(safe-area-inset-top),3rem)]">
      <header className="space-y-2 text-center">
        <h1 className="text-5xl font-semibold tracking-[-0.04em]">Plus</h1>
        <p className="text-lg text-secondary">Your money, by voice. Save, pay and borrow fairly.</p>
      </header>

      <WalletCard />

      <div className="space-y-3">
        <Button className="w-full" onClick={() => setView('signup')}>{W.openAccount.en}</Button>
        <Button variant="secondary" className="w-full" onClick={() => setView('signin')}>{W.haveAccount.en}</Button>
      </div>

      {demoOn !== false && (
        <Section title="Demo people">
          <ListGroup>
            {DEMO.map((p) => (
              <li key={p.email}>
                <button
                  onClick={() => void demo(p.email)}
                  disabled={busy !== null}
                  className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-fill disabled:opacity-60"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-base font-semibold text-accent-ink" aria-hidden="true">{p.label[0]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-medium leading-snug">Continue as {p.label}</span>
                    <span className="block truncate text-sm text-secondary">{p.note}</span>
                  </span>
                  {busy === p.email ? <Spinner className="text-secondary" /> : <Icon name="chevron" className="text-lg text-secondary" />}
                </button>
              </li>
            ))}
          </ListGroup>
          {error && <Notice tone="danger">{error}</Notice>}
          <p className="px-1 pt-1 text-center text-sm text-secondary">Stellar testnet. All money is simulated.</p>
        </Section>
      )}
    </main>
  )
}
