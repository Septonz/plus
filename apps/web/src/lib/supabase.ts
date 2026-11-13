import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// Null until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in the repo-root .env.local.
// The helper page keeps its own session, so Selvi's app and Meena's page can be open side by side.
// The agent page (/agent) has its own too, so Funmi's app and Mama Bisi's page can run together.
// The staff demo view (/demo) has its own, and the phones it shows (/app?as=funmi, /app?as=selvi)
// each keep theirs, so switching Nigeria / India on the projector is instant and logs nobody out.
const path = typeof window !== 'undefined' ? window.location.pathname : ''
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
/** Set on /app?as=funmi or /app?as=selvi: sign in as that demo person automatically. */
export const DEMO_AS: 'funmi' | 'selvi' | null = path.startsWith('/app') && (params.get('as') === 'funmi' || params.get('as') === 'selvi') ? (params.get('as') as 'funmi' | 'selvi') : null
const storageKey = path.startsWith('/helper') ? 'plus-helper-auth'
  : path.startsWith('/agent') ? 'plus-agent-auth'
  : path.startsWith('/demo') ? 'plus-demo-auth'
  : DEMO_AS ? `plus-auth-${DEMO_AS}`
  : 'plus-auth'
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey, { auth: { persistSession: true, storageKey } }) : null

/** A client that signs in for another page (the landing page signs a guest agent in for /agent). */
export function clientFor(page: '/app' | '/agent'): SupabaseClient | null {
  if (!url || !anonKey) return null
  if (page === '/app' && storageKey === 'plus-auth') return supabase
  return createClient(url, anonKey, { auth: { persistSession: true, storageKey: page === '/agent' ? 'plus-agent-auth' : 'plus-auth', autoRefreshToken: false } })
}

// Demo logins (dev project only; created by `pnpm seed:db`). Production login is phone OTP plus PIN.
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_LOGIN_PASSWORD as string | undefined
export const DEMO_SELVI_EMAIL = 'demo-selvi@example.com'
export const DEMO_MEENA_EMAIL = 'demo-meena@example.com'
export const DEMO_FUNMI_EMAIL = 'demo-funmi@example.com'
/** Kemi: new to Plus (week 4 of 6), building her history toward a first loan. Created by `pnpm demo:reset ng`. */
export const DEMO_KEMI_EMAIL = 'demo-kemi@example.com'
/** Amaka: with Plus 20 weeks, verified ID; Kemi asks her to witness an asset. Set up by `pnpm demo:reset ng`. */
export const DEMO_AMAKA_EMAIL = 'demo-amaka@example.com'
export const DEMO_MAMA_BISI_EMAIL = 'demo-mamabisi@example.com'
