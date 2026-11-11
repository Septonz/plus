// Plus Nigeria wording helpers: simple English (Pidgin-friendly) in big type, Yoruba underneath.
// Every label lives in translations.ts (one file, for the Yoruba review).
import { formatTime } from '../lib/time'
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

/** A label in her language (Profile > Language): Yoruba or Pidgin when there is one, else English. {x} / {n} filled in. */
export function inLang(k: WKey, lang: string | null | undefined, fill: { x?: string; n?: string } = {}): string {
  const w = W[k] as { en: string; yo: string; pcm?: string }
  const s = (lang === 'yo' && w.yo) || (lang === 'pcm' && w.pcm) || w.en
  return s.replace('{x}', fill.x ?? '').replace('{n}', fill.n ?? '')
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
  // Calendar days (yesterday at 23:00 is "yesterday", not "today").
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(new Date()) - day(d)) / 86_400_000)
  const time = formatTime(d)
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
