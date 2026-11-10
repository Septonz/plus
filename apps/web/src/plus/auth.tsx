// Demo sign-in (dev project only). Production login is phone OTP plus PIN; see README.
import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { DEMO_PASSWORD, supabase } from '../lib/supabase'
import { BigButton, L, Notice } from './ui'
import type { Key } from './i18n'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!supabase)
  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])
  return { session, ready }
}

/** /app?as=funmi (the phone on the staff /demo view): sign in as that demo person by itself. */
export function AutoSignIn({ email, name }: { email: string; name: string }) {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!supabase || !DEMO_PASSWORD) {
      setError('Demo logins are not set up (pnpm seed:db).')
      return
    }
    void supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD }).then(({ error }) => error && setError(error.message))
  }, [email])
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas p-6 text-label">
      <img src="/icons/icon-192.png" alt="" className="size-24 rounded-[2rem] shadow-lg" />
      {error ? <Notice tone="chili">{error}</Notice> : <p className="text-2xl font-semibold">Opening {name}'s Plus…</p>}
    </main>
  )
}

/** Several demo people on one page (the /app login): plain labels, first one is the main demo. */
export function DemoChoice({ people }: { people: { email: string; label: string; note: string }[] }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function signIn(email: string) {
    if (!supabase) return setError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the repo-root .env.local.')
    if (!DEMO_PASSWORD) return setError('Run `pnpm seed:db` to create the demo logins (it writes VITE_DEMO_LOGIN_PASSWORD).')
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD })
    setBusy(false)
    if (error) setError(error.message)
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 bg-canvas px-6 py-10 text-label">
      <div className="text-center">
        <img src="/icons/icon-192.png" alt="" className="mx-auto size-28 rounded-[2rem] shadow-lg" />
        <h1 className="mt-5 text-5xl font-semibold text-accent-ink">Plus</h1>
        <p className="mt-3 text-2xl font-semibold">Your money, by voice</p>
      </div>
      {people.map((p, i) => (
        <BigButton key={p.email} tone={i === 0 ? 'brick' : 'white'} className="min-h-20 w-full text-2xl" onClick={() => void signIn(p.email)} disabled={busy}>
          <span className="flex flex-col leading-tight">
            <span>{p.label}</span>
            <span className={`text-base font-normal ${i === 0 ? 'text-on-accent/80' : 'text-secondary'}`}>{p.note}</span>
          </span>
        </BigButton>
      ))}
      {error && <Notice tone="chili">{error}</Notice>}
      <p className="text-center text-base text-secondary">Demo only. In production: phone OTP plus PIN.</p>
    </main>
  )
}

export function DemoLogin({ email, label }: { email: string; label: Key }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    if (!supabase) return setError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the repo-root .env.local.')
    if (!DEMO_PASSWORD) return setError('Run `pnpm seed:db` to create the demo logins (it writes VITE_DEMO_LOGIN_PASSWORD).')
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password: DEMO_PASSWORD })
    setBusy(false)
    if (error) setError(error.message)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 bg-canvas px-6 py-10 text-label">
      <div className="text-center">
        <img src="/icons/icon-192.png" alt="" className="mx-auto size-28 rounded-[2rem] shadow-lg" />
        <h1 className="mt-5 text-5xl font-semibold text-accent-ink">
          <L k="appName" />
        </h1>
        <p className="mt-3 text-2xl font-semibold">
          <L k="tagline" />
        </p>
      </div>
      <BigButton className="min-h-20 w-full text-2xl" onClick={signIn} disabled={busy}>
        <L k={label} sub="text-on-accent/80" />
      </BigButton>
      {error && <Notice tone="chili">{error}</Notice>}
      <p className="text-center text-base text-secondary">
        <L k="demoLoginNote" />
      </p>
    </main>
  )
}
