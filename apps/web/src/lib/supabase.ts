import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

// Null until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set in the repo-root .env.local.
export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey, { auth: { persistSession: true, storageKey: 'plus-auth' } }) : null

// Demo logins (dev project only; created by `pnpm seed:db`). Production login is phone OTP plus PIN.
export const DEMO_PASSWORD = import.meta.env.VITE_DEMO_LOGIN_PASSWORD as string | undefined
export const DEMO_SELVI_EMAIL = 'demo-selvi@example.com'
export const DEMO_MEENA_EMAIL = 'demo-meena@example.com'
