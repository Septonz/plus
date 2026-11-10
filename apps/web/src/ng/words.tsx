// Plus Nigeria wording: simple English (Pidgin-friendly) in big type, Yoruba underneath.
// The app picks these for users whose market pack is "ng".
import { type ReactNode } from 'react'
import { formatMoney } from '@plus/markets'
import type { MicWords } from '../plus/voice'

export const W = {
  hello: { en: 'Hello', yo: 'Báwo ni' },
  wallet: { en: 'Your wallet', yo: 'Àpò owó rẹ' },
  onStellar: { en: 'Your wallet is on Stellar', yo: '' },
  home: { en: 'Home', yo: 'Ilé' },
  addCash: { en: 'Add cash', yo: 'Fi owó sí' },
  pay: { en: 'Pay', yo: 'Sanwó' },
  ajo: { en: 'Ajo', yo: 'Àjọ' },
  advance: { en: 'Advance', yo: 'Yá owó' },
  cashOut: { en: 'Cash out', yo: 'Gba owó' },
  record: { en: 'My record', yo: 'Ìwé mi' },
  settings: { en: 'Settings', yo: 'Ètò' },
  yes: { en: 'Yes', yo: 'Bẹ́ẹ̀ ni' },
  no: { en: 'No', yo: 'Rárá' },
  close: { en: 'Close', yo: 'Padé' },
  next: { en: 'Next', yo: 'Tẹ̀síwájú' },
  isThatRight: { en: 'Is that right?', yo: 'Ṣé bẹ́ẹ̀ ni?' },
  checkThis: { en: 'Check am well', yo: 'Wò ó dáadáa' },
  sending: { en: 'Sending on Stellar…', yo: 'Ó ń lọ…' },
  verified: { en: 'Verified on Stellar', yo: '' },
  done: { en: 'Done', yo: 'Ó ti parí' },
  whoPay: { en: 'Who you wan pay?', yo: 'Ta ni o fẹ́ san fún?' },
  howMuch: { en: 'How much?', yo: 'Èló ni?' },
  typePin: { en: 'Type your PIN', yo: 'Tẹ PIN rẹ' },
  pinHidden: { en: 'No tell anybody your PIN', yo: 'Má sọ PIN rẹ fún ẹnikẹ́ni' },
  waiting: { en: 'Waiting for your answer', yo: 'Ó ń dúró dè ọ́' },
  members: { en: 'Members', yo: 'Àwọn ọmọ ẹgbẹ́' },
  turn: { en: 'Turn', yo: 'Ìgbà' },
  paid: { en: 'Paid', yo: 'Ó ti san' },
  notYet: { en: 'Not yet', yo: 'Kò tíì san' },
  payMyPart: { en: 'Pay my part', yo: 'San ìpín mi' },
  showCode: { en: 'Show the agent this code', yo: 'Fi kóòdù yìí han aṣojú' },
  newCode: { en: 'Show code', yo: 'Fi kóòdù hàn' },
  signOut: { en: 'Sign out', yo: 'Jáde' },
  speak: { en: 'Talk to Plus', yo: 'Sọ̀rọ̀' },
} as const
export type WKey = keyof typeof W

/** English big, Yoruba small underneath. */
export function Y({ k, className = '', sub = 'text-ink-soft' }: { k: WKey; className?: string; sub?: string }) {
  const w = W[k]
  if (!w.yo) return <span className={className}>{w.en}</span>
  return (
    <span className={`inline-flex flex-col leading-tight ${className}`}>
      <span>{w.en}</span>
      <span className={`text-base font-normal ${sub}`}>{w.yo}</span>
    </span>
  )
}

export const naira = (kobo: number | string | bigint) => formatMoney(BigInt(kobo), 'ng')

export const MIC_WORDS: MicWords = {
  mic: 'Talk to Plus · Sọ̀rọ̀',
  micListening: 'I dey listen…',
  micSpeaking: 'Plus dey talk…',
  micConnecting: 'Connecting…',
  micStop: 'Tap to stop',
  micError: 'Voice no dey work now',
}

export function Big({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-5xl font-extrabold tracking-tight text-brick ${className}`}>{children}</p>
}

export function when(iso: string): string {
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  const time = d.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })
  if (days <= 0) return `today ${time}`
  if (days === 1) return `yesterday ${time}`
  return `${days} days ago`
}
