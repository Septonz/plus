// Sign-up illustrations: simple original shapes (circles, rounded rectangles, a few lines) in the
// Plus colours. No stock art, no logos. Each is decorative (aria-hidden); the words carry meaning.
import type { ReactNode } from 'react'

const C = {
  brick: 'var(--color-brick)',
  saffron: 'var(--color-saffron)',
  turmeric: 'var(--color-turmeric)',
  leaf: 'var(--color-leaf)',
  leafSoft: 'var(--color-leaf-soft)',
  sand: 'var(--color-sand)',
  sandDeep: 'var(--color-sand-deep)',
  cream: 'var(--color-cream)',
  ink: 'var(--color-ink)',
  sky: 'var(--color-sky)',
  skySoft: 'var(--color-sky-soft)',
  white: '#fff',
}

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 240 160" className="mx-auto block h-36 w-auto max-w-full" aria-hidden="true" data-art={label}>
      <ellipse cx="120" cy="146" rx="96" ry="10" fill={C.sandDeep} opacity="0.6" />
      {children}
    </svg>
  )
}

/** A person under a sun beside a market stall: the welcome. */
export function ArtWelcome() {
  return (
    <Frame label="welcome">
      <circle cx="190" cy="36" r="20" fill={C.turmeric} />
      <rect x="28" y="70" width="92" height="70" rx="8" fill={C.sand} />
      <path d="M22 72h104l-10-26H32z" fill={C.saffron} />
      <path d="M32 46h16l-4 26H22zM64 46h16v26H60zM96 46h16l10 26h-22z" fill={C.brick} opacity="0.85" />
      <circle cx="52" cy="104" r="10" fill={C.brick} />
      <circle cx="74" cy="108" r="9" fill={C.saffron} />
      <circle cx="94" cy="104" r="10" fill={C.brick} />
      <circle cx="166" cy="72" r="16" fill={C.brick} />
      <path d="M140 140c0-30 12-48 26-48s26 18 26 48z" fill={C.leaf} />
      <path d="M148 56c6-12 30-12 36 0" stroke={C.saffron} strokeWidth="8" strokeLinecap="round" fill="none" />
    </Frame>
  )
}

/** A face with a speech bubble: name and language. */
export function ArtHello() {
  return (
    <Frame label="hello">
      <circle cx="92" cy="74" r="26" fill={C.brick} />
      <path d="M52 140c0-34 18-48 40-48s40 14 40 48z" fill={C.saffron} />
      <rect x="128" y="22" width="88" height="56" rx="18" fill={C.white} stroke={C.sandDeep} strokeWidth="3" />
      <path d="M140 74l-14 18 28-14z" fill={C.white} />
      <circle cx="152" cy="50" r="6" fill={C.brick} />
      <circle cx="172" cy="50" r="6" fill={C.saffron} />
      <circle cx="192" cy="50" r="6" fill={C.leaf} />
    </Frame>
  )
}

/** A phone receiving a message: the phone code. */
export function ArtPhone() {
  return (
    <Frame label="phone">
      <rect x="84" y="14" width="72" height="128" rx="14" fill={C.ink} />
      <rect x="91" y="26" width="58" height="100" rx="6" fill={C.cream} />
      <rect x="98" y="40" width="44" height="22" rx="8" fill={C.skySoft} />
      <rect x="104" y="48" width="24" height="5" rx="2.5" fill={C.sky} />
      <rect x="98" y="70" width="36" height="8" rx="4" fill={C.sandDeep} />
      <rect x="98" y="84" width="44" height="8" rx="4" fill={C.sandDeep} />
      <circle cx="120" cy="134" r="3" fill={C.sand} />
      <path d="M170 40c10 8 10 24 0 32M182 30c16 14 16 38 0 52" stroke={C.saffron} strokeWidth="6" strokeLinecap="round" fill="none" />
    </Frame>
  )
}

/** A padlock with four dots: the PIN. */
export function ArtLock() {
  return (
    <Frame label="lock">
      <path d="M90 70V52a30 30 0 0 1 60 0v18" stroke={C.brick} strokeWidth="12" fill="none" strokeLinecap="round" />
      <rect x="70" y="66" width="100" height="76" rx="16" fill={C.saffron} />
      {[94, 112, 130, 148].map((x) => <circle key={x} cx={x} cy="104" r="7" fill={C.white} />)}
    </Frame>
  )
}

/** A face inside a camera frame: the photo check. */
export function ArtSelfie() {
  return (
    <Frame label="selfie">
      <path d="M70 30h-14v14M170 30h14v14M70 136h-14v-14M170 136h14v-14" stroke={C.brick} strokeWidth="7" strokeLinecap="round" fill="none" />
      <circle cx="120" cy="70" r="24" fill={C.brick} />
      <path d="M80 132c0-26 18-38 40-38s40 12 40 38z" fill={C.leaf} />
      <circle cx="186" cy="84" r="16" fill={C.leafSoft} />
      <path d="M179 84l5 5 9-10" stroke={C.leaf} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Frame>
  )
}

/** An ID card with a shield: the NIN check. */
export function ArtId() {
  return (
    <Frame label="id">
      <rect x="40" y="36" width="124" height="86" rx="12" fill={C.white} stroke={C.sandDeep} strokeWidth="3" />
      <rect x="40" y="36" width="124" height="20" rx="10" fill={C.sky} />
      <circle cx="74" cy="84" r="14" fill={C.saffron} />
      <rect x="98" y="74" width="50" height="7" rx="3.5" fill={C.sandDeep} />
      <rect x="98" y="88" width="36" height="7" rx="3.5" fill={C.sandDeep} />
      <path d="M182 64l26 10v18c0 16-11 28-26 32-15-4-26-16-26-32V74z" fill={C.leaf} />
      <path d="M171 92l8 8 14-15" stroke={C.white} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Frame>
  )
}

/** Two people side by side: the trusted contact. */
export function ArtPeople() {
  return (
    <Frame label="people">
      <circle cx="94" cy="64" r="20" fill={C.brick} />
      <path d="M60 140c0-30 15-44 34-44s34 14 34 44z" fill={C.saffron} />
      <circle cx="148" cy="70" r="18" fill={C.sky} />
      <path d="M118 140c0-26 13-38 30-38s30 12 30 38z" fill={C.leaf} />
      <path d="M120 40c-6-8-20-4-16 8l16 14 16-14c4-12-10-16-16-8z" fill={C.saffron} />
    </Frame>
  )
}

/** A wallet with a star coming out: the account opening. */
export function ArtWallet({ ready = false }: { ready?: boolean }) {
  return (
    <Frame label="wallet">
      <rect x="50" y="52" width="140" height="88" rx="16" fill={C.brick} />
      <path d="M58 52l90-30 12 30z" fill={C.saffron} />
      <rect x="150" y="82" width="46" height="30" rx="10" fill={C.turmeric} />
      <circle cx="166" cy="97" r="6" fill={C.brick} />
      {ready ? (
        <>
          <circle cx="78" cy="34" r="18" fill={C.leaf} />
          <path d="M70 34l6 6 11-12" stroke={C.white} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      ) : (
        <path d="M80 16l5 14 14 5-14 5-5 14-5-14-14-5 14-5z" fill={C.turmeric} />
      )}
    </Frame>
  )
}
