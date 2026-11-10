// Selvi's data, read through RLS (her own rows only) and kept live with Realtime: a change to
// her pending_actions, transactions or cash_events refetches what the screens show. When the
// voice agent prepares an action, its pending_actions row arrives here and the confirm screen opens.
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMoney, getMarket, type MarketId } from '@plus/markets'
import { supabase } from '../lib/supabase'

export type Me = {
  id: string
  name: string | null
  language: string
  market_id: MarketId
  auto_save_bps: number
  trusted_contact_phone: string | null
}
export type Account = { balance_paise: number; savings_paise: number; bank_name: string }
export type Tx = {
  id: string
  kind: string
  source: string | null
  amount: number
  created_at: string
  chain_tx_hash: string | null
  status?: 'pending' | 'completed' | 'failed'
}
export type PendingAction = {
  id: string
  kind: 'pay' | 'group_contribution' | 'set_auto_save' | 'confirm_cash_in' | string
  params: Record<string, unknown>
  readback: string
  status: string
  result: Record<string, unknown> | null
  expires_at: string
  created_by: 'user' | 'helper'
  created_at: string
}
export type Payee = { id: string; name: string; upi_handle: string | null }

export type PlusData = {
  me: Me | null
  account: Account | null
  txs: Tx[]
  pending: PendingAction[]
  payees: Payee[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Bumped on every Realtime change, so screens with their own tool reads can refetch. */
  version: number
}

export const money = (minor: number | string | bigint, market: MarketId = 'in') => formatMoney(BigInt(minor), market)

export function needsPin(a: PendingAction, market: MarketId = 'in'): boolean {
  if (a.kind !== 'pay' && a.kind !== 'group_contribution') return false
  return BigInt(String(a.params.amount ?? 0)) > BigInt(getMarket(market).pinThreshold) * 100n
}

export function usePlusData(authUserId: string | null): PlusData {
  const [me, setMe] = useState<Me | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [txs, setTxs] = useState<Tx[]>([])
  const [pending, setPending] = useState<PendingAction[]>([])
  const [payees, setPayees] = useState<Payee[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const timer = useRef<number | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!supabase || !authUserId) return
    const meRes = await supabase
      .from('users')
      .select('id, name, language, market_id, auto_save_bps, trusted_contact_phone')
      .eq('auth_user_id', authUserId)
      .maybeSingle()
    if (meRes.error) {
      setError(meRes.error.message)
      setLoading(false)
      return
    }
    if (!meRes.data) {
      setError('no_plus_account')
      setLoading(false)
      return
    }
    const uid = meRes.data.id as string
    const [acct, tx, pa, py] = await Promise.all([
      supabase.from('sim_bank_accounts').select('balance_paise, savings_paise, bank_name').eq('user_id', uid).maybeSingle(),
      supabase
        .from('transactions')
        .select('id, kind, source, amount, created_at, chain_tx_hash, status')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(40),
      supabase
        .from('pending_actions')
        .select('id, kind, params, readback, status, result, expires_at, created_by, created_at')
        .eq('user_id', uid)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
      supabase.from('payees').select('id, name, upi_handle').eq('user_id', uid).order('name'),
    ])
    setMe(meRes.data as Me)
    setAccount((acct.data as Account) ?? null)
    setTxs((tx.data as Tx[]) ?? [])
    setPending((pa.data as PendingAction[]) ?? [])
    setPayees((py.data as Payee[]) ?? [])
    setError(acct.error?.message ?? tx.error?.message ?? pa.error?.message ?? null)
    setLoading(false)
  }, [authUserId])

  useEffect(() => {
    // Initial load; state is set after the awaits inside refresh.
    void refresh()
  }, [refresh])

  // Realtime: her own rows only (RLS applies to postgres_changes too).
  const userId = me?.id
  useEffect(() => {
    const client = supabase
    if (!client || !userId) return
    const onChange = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        void refresh()
        setVersion((v) => v + 1)
      }, 150)
    }
    const channel = client.channel(`plus-${userId}`)
    // wallet_balances and cash_out_codes: Nigeria (her wallet on Stellar); nothing arrives for India.
    for (const table of ['pending_actions', 'transactions', 'cash_events', 'wallet_balances', 'cash_out_codes']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` }, onChange)
    }
    channel.subscribe()
    return () => {
      window.clearTimeout(timer.current)
      void client.removeChannel(channel)
    }
  }, [userId, refresh])

  return { me, account, txs, pending, payees, loading, error, refresh, version }
}

export function whenText(iso: string, lang: 'ta' | 'en'): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return lang === 'ta' ? 'இன்னைக்கு' : 'today'
  if (days === 1) return lang === 'ta' ? 'நேத்து' : 'yesterday'
  return lang === 'ta' ? `${days} நாள் முன்னாடி` : `${days} days ago`
}
