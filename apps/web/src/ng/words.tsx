// Plus Nigeria wording helpers: simple English (Pidgin-friendly) in big type, Yoruba underneath.
// Every label lives in translations.ts (one file, for the Yoruba review).
import { formatMoney } from '@plus/markets'
import type { MicWords } from '../plus/voice'
import { W } from './translations'

export { W }
export type WKey = keyof typeof W

/** English big, Yoruba small underneath. */
export function Y({ k, className = '', sub = 'text-secondary' }: { k: WKey; className?: string; sub?: string }) {
  const w = W[k]
  if (!w.yo) return <span className={className}>{w.en}</span>
  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span>{w.en}</span>
      <span className={`mt-0.5 text-sm font-normal tracking-normal ${sub}`}>{w.yo}</span>
    </span>
  )
}

/** The Yoruba line only (for places that set the English themselves). */
export const yo = (k: WKey): string | undefined => W[k].yo || undefined

export const naira = (kobo: number | string | bigint) => formatMoney(BigInt(kobo), 'ng')

export const MIC_WORDS: MicWords = {
  mic: `${W.speak.en} · ${W.speak.yo}`,
  micListening: W.micListening.en,
  micSpeaking: W.micSpeaking.en,
  micConnecting: W.micConnecting.en,
  micStop: W.micStop.en,
  micError: W.micError.en,
  micSoon: `${W.micSoon.en} · ${W.micSoon.yo}`,
}


export function when(iso: string): string {
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  const time = d.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })
  if (days <= 0) return `today ${time}`
  if (days === 1) return `yesterday ${time}`
  return `${days} days ago`
}

/**
 * The tools' refusal texts are written for the voice agent ("She has 4,200 naira", "Ask her to...").
 * On her own screen they read as "you".
 */
export function forScreen(text: string): string {
  return text
    .replace(/\bAsk her to\b/g, 'Please')
    .replace(/\bShe has\b/g, 'You have').replace(/\bshe has\b/g, 'you have')
    .replace(/\bShe is\b/g, 'You are').replace(/\bshe is\b/g, 'you are')
    .replace(/\bShe\b/g, 'You').replace(/\bshe\b/g, 'you')
    .replace(/\bHer\b/g, 'Your').replace(/\bher\b/g, 'your')
}
