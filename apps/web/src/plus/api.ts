// Calls to the Plus Edge Functions with the signed-in user's token. The app uses the same
// agent-tools router as the voice agent, so taps and voice share one code path.
import { supabase } from '../lib/supabase'

export type ToolResult = { text: string; ok?: boolean; error?: string; [k: string]: unknown }

export async function call<T = ToolResult>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)')
  const { data, error } = await supabase.functions.invoke(path, { body })
  if (error) {
    // Non-2xx: the function still answers with { error, text } JSON.
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        return (await ctx.json()) as T
      } catch {
        // fall through
      }
    }
    throw error
  }
  return data as T
}

export const tool = <T = ToolResult>(name: string, body: Record<string, unknown> = {}) => call<T>(`agent-tools/${name}`, body)

export function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}
