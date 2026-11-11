// Piece 11: pay a shop. "My code" shows her pay code and a QR of a Plus pay link (never a raw
// Stellar address); "Scan to pay" reads a shop's QR with the camera (or she types the code) and goes
// through the same prepare_pay -> confirm sheet as any payment.
import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AmountDisplay, Button, Card, Icon, ListGroup, ListRow, Notice, NumPad, Section, applyKey } from '../ds/components'
import { tool, type ToolResult } from '../plus/api'
import { useSays } from '../plus/screen'
import { CopyButton, TextField } from '../plus/ui'
import { useTool } from './NgApp'
import { forScreen, naira, W } from './words'

const EXPLORER = 'https://stellar.expert/explorer/testnet'

/** A QR code drawn as one SVG path (crisp at any size, dark on white so every camera reads it). */
export function QrCode({ text, size = 224 }: { text: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(text)
    q.make()
    const n = q.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
    return { n, d }
  }, [text])
  return (
    <svg role="img" aria-label="Pay code QR" viewBox={`0 0 ${n + 8} ${n + 8}`} width={size} height={size} className="rounded-xl bg-white" shapeRendering="crispEdges">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

/** Receive: her pay code and its QR. */
export function Receive({ version }: { version: number }) {
  const r = useTool('my_pay_code', version)
  useSays(r?.ok ? `Receive. Her pay code ${String(r.pay_code_text)} with a QR. Anyone on Plus scans it or types the code to pay her; it goes straight to her wallet. A Copy button.` : 'Receive, loading.')
  if (!r) return <Card className="h-80 animate-pulse">{null}</Card>
  if (!r.ok) return <Notice tone="danger">{forScreen(String(r.text))}</Notice>
  return (
    <>
      <Card className="flex flex-col items-center gap-4 py-6 text-center">
        <QrCode text={String(r.pay_link)} />
        <div>
          <p className="text-sm text-secondary">My pay code</p>
          <p className="num font-mono text-3xl font-semibold tracking-widest">{String(r.pay_code_text)}</p>
        </div>
        <CopyButton text={String(r.pay_code_text)} label="Copy code" />
      </Card>
      <p className="px-1 text-sm text-secondary">Customers on Plus scan this or type the code. The money goes straight to your wallet on Stellar. It's not a secret: it only lets people pay you.</p>
    </>
  )
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }
const hasDetector = () => typeof window !== 'undefined' && 'BarcodeDetector' in window

/** Scan to pay: camera (where the browser can read QR codes), or type the code; then the amount. */
export function Scan({ initialCode, onPaid }: { initialCode?: string | null; onPaid?: () => void }) {
  const [code, setCode] = useState(initialCode ?? '')
  const [scanning, setScanning] = useState(false)
  const [camError, setCamError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const ready = clean.length === 6
  useSays(`Scan to pay. ${scanning ? 'The camera is open: she points it at the shop’s QR.' : 'A Scan button opens the camera; or she types the 6-character pay code.'}` +
    (ready ? ` Code ${clean.slice(0, 3)}-${clean.slice(3)} entered; amount ${amount ? naira(BigInt(amount) * 100n) : 'not typed yet'}; then Next.` : ''))

  useEffect(() => {
    if (!scanning) return
    let stream: MediaStream | null = null
    let timer = 0
    let live = true
    const Ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector
    const detector = new Ctor({ formats: ['qr_code'] })
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      if (!live) return s.getTracks().forEach((t) => t.stop())
      stream = s
      if (video.current) {
        video.current.srcObject = s
        void video.current.play()
      }
      const tick = async () => {
        if (!live || !video.current) return
        try {
          const found = await detector.detect(video.current)
          const raw = found[0]?.rawValue
          const m = raw?.match(/\/pay\/([A-Za-z0-9]{6})\b/) ?? raw?.match(/^([A-Za-z0-9]{3}-?[A-Za-z0-9]{3})$/)
          if (m) {
            setCode(m[1].toUpperCase())
            setScanning(false)
            return
          }
        } catch { /* keep looking */ }
        timer = window.setTimeout(() => void tick(), 300)
      }
      void tick()
    }, () => {
      setCamError('The camera did not open. Type the code instead.')
      setScanning(false)
    })
    return () => {
      live = false
      window.clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [scanning])

  async function next() {
    setBusy(true)
    setMsg(null)
    const r = await tool('prepare_pay', { code: clean, amount }).catch(() => ({ text: 'No connection. Try again.', ok: false }) as ToolResult)
    setBusy(false)
    if (!r.ok) setMsg(forScreen(String(r.text)))
    else {
      setAmount('')
      onPaid?.()
    }
  }

  return (
    <>
      {scanning ? (
        <Card className="space-y-3">
          <video ref={video} muted playsInline className="aspect-square w-full rounded-xl bg-black object-cover" />
          <Button variant="secondary" className="w-full" onClick={() => setScanning(false)}>Stop</Button>
        </Card>
      ) : (
        <Card className="space-y-4">
          {hasDetector() && (
            <Button className="w-full" onClick={() => { setCamError(null); setScanning(true) }}><Icon name="code" /> Scan the shop's QR</Button>
          )}
          {camError && <Notice tone="warning">{camError}</Notice>}
          <TextField label="Or type the pay code" value={code} onChange={(v) => setCode(v.toUpperCase().slice(0, 7))} placeholder="ABC-234" autoComplete="off" />
        </Card>
      )}
      {ready && (
        <Section title={W.howMuch.en}>
          <Card className="space-y-4">
            <div className="py-2 text-center" aria-live="polite">
              <AmountDisplay text={naira(BigInt(amount || '0') * 100n)} size="xl" className={amount ? '' : 'text-secondary'} />
            </div>
            <NumPad onKey={(k) => setAmount(applyKey(amount, k, 7))} />
            {msg && <Notice tone="danger">{msg}</Notice>}
            <Button className="w-full" loading={busy} disabled={!amount} onClick={() => void next()}>{W.next.en}</Button>
          </Card>
        </Section>
      )}
      <p className="px-1 text-sm text-secondary">It goes straight to the shop's Plus wallet on Stellar. You check the name before you say yes.</p>
    </>
  )
}

/** Profile: her wallet's Stellar address (for the curious; she never needs it to get paid). */
export function StellarDetails({ pub }: { pub: string | null }) {
  const [open, setOpen] = useState(false)
  if (!pub) return null
  return (
    <ListGroup>
      <ListRow icon="globe" title="Stellar details" subtitle={open ? undefined : 'Your wallet address on Stellar'} chevron onClick={() => setOpen((o) => !o)} />
      {open && (
        <div className="space-y-3 px-4 pb-4">
          <p className="break-all font-mono text-sm">{pub}</p>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton text={pub} label="Copy address" />
            <a className="inline-flex min-h-11 items-center gap-1 text-base font-medium text-accent-ink" href={`${EXPLORER}/account/${pub}`} target="_blank" rel="noreferrer">
              See it on Stellar <Icon name="link" />
            </a>
          </div>
          <p className="text-sm text-secondary">Testnet. To get paid, share your pay code instead; your account number is for bank transfers.</p>
        </div>
      )}
    </ListGroup>
  )
}
