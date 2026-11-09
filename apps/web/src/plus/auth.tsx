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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 bg-cream px-6 py-10 text-ink">
      <div className="text-center">
        <img src="/icons/icon-192.png" alt="" className="mx-auto size-28 rounded-[2rem] shadow-lg" />
        <h1 className="mt-5 text-5xl font-extrabold text-brick">
          <L k="appName" />
        </h1>
        <p className="mt-3 text-2xl font-bold">
          <L k="tagline" />
        </p>
      </div>
      <BigButton className="min-h-20 w-full text-2xl" onClick={signIn} disabled={busy}>
        <L k={label} sub="text-cream/80" />
      </BigButton>
      {error && <Notice tone="chili">{error}</Notice>}
      <p className="text-center text-base text-ink-soft">
        <L k="demoLoginNote" />
      </p>
    </main>
  )
}
