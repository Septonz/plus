import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// Null until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in the repo-root .env.local.
// The helper page keeps its own session, so Selvi's app and Meena's page can be open side by side.
const storageKey = typeof window !== 'undefined' && window.location.pathname.startsWith('/helper') ? 'plus-helper-auth' : 'plus-auth'
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey, { auth: { persistSession: true, storageKey } }) : null

// Demo logins (dev project only; created by `pnpm seed:db`). Production login is phone OTP plus PIN.
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_LOGIN_PASSWORD as string | undefined
export const DEMO_SELVI_EMAIL = 'demo-selvi@example.com'
export const DEMO_MEENA_EMAIL = 'demo-meena@example.com'
