// Assets (piece 5): what she owns for her business, and how far it is verified. Four levels, one
// step at a time: registered -> a live photo (time and approximate place) -> two people who know her
// business confirm -> an agent inspects it. The confidence score lenders use is never shown here.
// Also: requests from people who asked HER to confirm their asset (she is the witness).
import { useEffect, useRef, useState } from 'react'
import {
  AmountDisplay, Bilingual, Button, Card, EmptyState, Icon, ListGroup, ListRow, Notice, NumPad, Section, applyKey,
} from '../ds/components'
import { tool, type ToolResult } from '../plus/api'
import { useSays } from '../plus/screen'
import { LoadingList, TextField } from '../plus/ui'
import { forScreen, naira, W, yo } from './words'

type Row = Record<string, unknown>

const LEVELS: [string, string, string][] = [
  ['registered', 'Registered', 'You told Plus about it'],
  ['evidence_verified', 'Photo checked', 'A live photo, with the time and place'],
  ['community_verified', 'Confirmed by two people', 'People who know your business'],
  ['independently_verified', 'Inspected', 'A Plus agent saw it in person'],
]
const TYPES: [string, string][] = [['stock', 'Stock'], ['tools', 'Tools'], ['machine', 'Machine'], ['motorcycle', 'Motorcycle'], ['livestock', 'Livestock']]
const TYPE_ICON: Record<string, string> = { stock: 'stock', tools: 'settings', machine: 'settings', motorcycle: 'globe', livestock: 'flower' }

// ---------------------------------------------------------------------------- take_photo (voice)

type PhotoAsk = { asset?: string; resolve: (text: string) => void }
let photoListener: ((ask: PhotoAsk) => void) | null = null

/** The voice agent's take_photo: opens the camera on the Assets screen; resolves when she saves or cancels. */
export function requestPhoto(asset?: string): Promise<string> {
  return new Promise((resolve) => {
    if (!photoListener) return resolve('The Assets screen is not open. Call navigate with "assets" first.')
    photoListener({ asset, resolve })
  })
}

// ---------------------------------------------------------------------------- the camera

/** A live photo only (no gallery): the camera, then the shutter. JPEG, at most 1024 px wide. */
function Camera({ onShot, onCancel }: { onShot: (jpeg: string, lat: number | null, lon: number | null) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const place = useRef<{ lat: number; lon: number } | null>(null)
  useEffect(() => {
    let stream: MediaStream | null = null
    let live = true
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (!live) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play().then(() => setReady(true))
        }
      })
      .catch(() => setErr('The camera did not open. Allow the camera for Plus and try again.'))
    if (!navigator.mediaDevices) setErr('This browser has no camera access.')
    // Approximate place, if she allows it (rounded to about 1 km on the server).
    navigator.geolocation?.getCurrentPosition(
      (p) => { place.current = { lat: p.coords.latitude, lon: p.coords.longitude } },
      () => undefined,
      { timeout: 8000, maximumAge: 300_000 },
    )
    return () => {
      live = false
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])
  function shoot() {
    const v = video.current
    if (!v || !v.videoWidth) return
    const scale = Math.min(1, 1024 / v.videoWidth)
    const c = document.createElement('canvas')
    c.width = Math.round(v.videoWidth * scale)
    c.height = Math.round(v.videoHeight * scale)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    onShot(c.toDataURL('image/jpeg', 0.75), place.current?.lat ?? null, place.current?.lon ?? null)
  }
  return (
    <Card className="space-y-3">
      {err ? <Notice tone="danger">{err}</Notice> : (
        <div className="relative overflow-hidden rounded-control bg-black">
          <video ref={video} playsInline muted className="aspect-[4/3] w-full object-cover" />
          {!ready && <p className="absolute inset-0 grid place-items-center text-white/80">Opening the camera…</p>}
        </div>
      )}
      <p className="text-sm text-secondary">Point at the whole thing, in good light. The photo is kept private; only the people checking it see it.</p>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="plain" onClick={onCancel}>Cancel</Button>
        <Button disabled={!ready} onClick={shoot}><Icon name="camera" /> {W.takeAssetPhoto.en}</Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------- one asset

function Levels({ level }: { level: string }) {
  const at = LEVELS.findIndex((l) => l[0] === level)
  return (
    <ListGroup>
      {LEVELS.map(([k, title, sub], i) => (
        <ListRow key={k} icon={i <= at ? 'check' : 'clock'} iconTone={i <= at ? 'success' : 'neutral'} title={title} subtitle={sub}
          trailing={i === at ? <span className="text-sm font-medium text-accent-ink">Now</span> : undefined} />
      ))}
    </ListGroup>
  )
}

function AssetView({ a, run, busy, onPhoto, onBack }: { a: Row; run: (n: string, args: Row) => Promise<ToolResult>; busy: boolean; onPhoto: () => void; onBack: () => void }) {
  const [asking, setAsking] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [cands, setCands] = useState<Row[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const next = a.next as string | null
  const gone = a.status === 'lost' || a.status === 'stolen' || a.status === 'released'
  async function openAsk() {
    setAsking(true)
    const r = await tool('witness_candidates')
    setCands(((r.candidates ?? []) as Row[]))
  }
  return (
    <div className="space-y-5">
      <button onClick={onBack} className="flex min-h-11 items-center gap-1 px-1 text-base font-medium text-accent-ink"><Icon name="back" /> All assets</button>
      <Card>
        <p className="text-sm text-secondary">{String(a.type).replace(/^./, (c) => c.toUpperCase())}</p>
        <p className="text-2xl font-semibold">{String(a.description)}</p>
        <AmountDisplay text={String(a.value_text)} size="md" label="Estimated value" className="mt-2" />
        {a.status !== 'active' && <Notice tone={a.status === 'under_review' ? 'info' : 'warning'}>It is marked {String(a.status_text)}. {a.status === 'under_review' ? 'A new live photo makes it active again.' : 'It does not count toward a loan for now.'}</Notice>}
        {a.pledged ? <p className="mt-2 text-sm text-secondary">It backs your loan.</p> : null}
      </Card>
      <Levels level={String(a.level)} />
      {a.next_text ? <p className="px-1 text-base text-secondary">{forScreen(String(a.next_text))}</p> : null}

      {!gone && (
        <div className="grid gap-3">
          {next === 'photo' && <Button onClick={onPhoto}><Icon name="camera" /> {W.takeAssetPhoto.en}</Button>}
          {next === 'witnesses' && !asking && <Button loading={busy} onClick={() => void openAsk()}><Icon name="group" /> {W.askWitnesses.en}</Button>}
          {next === 'inspection' && <Button loading={busy} onClick={() => void run('request_inspection', { asset_id: a.id })}><Icon name="shield" /> {W.askInspection.en}</Button>}
          {next !== 'photo' && a.level !== 'registered' && <Button variant="plain" onClick={onPhoto}>Take a new photo</Button>}
        </div>
      )}

      {asking && (
        <Section title="Who knows your business?">
          {!cands ? <LoadingList rows={3} /> : (
            <>
              <ListGroup>
                {cands.map((c) => {
                  const key = String(c.id)
                  return (
                    <ListRow key={key} icon={c.kind === 'agent' ? 'shield' : 'person'} iconTone={picked.has(key) ? 'accent' : 'neutral'}
                      title={String(c.name)}
                      subtitle={!c.eligible ? 'Can witness after 6 weeks with Plus and a verified ID' : c.how === 'agent' ? 'Plus agent' : c.how === 'ajo' ? 'From your ajo' : 'Someone you pay'}
                      selected={picked.has(key)}
                      onClick={c.eligible ? () => setPicked((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n }) : undefined}
                      trailing={picked.has(key) ? <Icon name="check" /> : undefined} />
                  )
                })}
              </ListGroup>
              <Button className="w-full" loading={busy} disabled={picked.size === 0} onClick={async () => {
                const r = await run('ask_witnesses', { asset_id: a.id, witnesses: [...picked] })
                if (r.ok) setAsking(false)
              }}>
                Ask {picked.size || ''} {picked.size === 1 ? 'person' : 'people'}
              </Button>
            </>
          )}
        </Section>
      )}

      {a.status !== 'released' && (reporting ? (
        <Section title="What happened?">
          <div className="grid grid-cols-2 gap-3">
            {(a.status === 'active' || a.status === 'under_review'
              ? [['lost', 'Lost'], ['stolen', 'Stolen'], ['damaged', 'Damaged'], ['released', 'Not mine any more']]
              : [[a.status === 'damaged' ? 'repaired' : 'found', a.status === 'damaged' ? 'Repaired' : 'Found it'], ['released', 'Not mine any more']]
            ).map(([s, label]) => (
              <Button key={s} variant="secondary" loading={busy} onClick={async () => {
                const r = await run('report_asset', { asset_id: a.id, status: s })
                if (r.ok) setReporting(false)
              }}>{label}</Button>
            ))}
          </div>
          <Button variant="plain" className="w-full" onClick={() => setReporting(false)}>Cancel</Button>
        </Section>
      ) : (
        <Button variant="plain" className="w-full" onClick={() => setReporting(true)}>Something changed</Button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------- register

function Register({ run, busy, onDone }: { run: (n: string, args: Row) => Promise<ToolResult>; busy: boolean; onDone: (id: string | null) => void }) {
  const [type, setType] = useState('stock')
  const [desc, setDesc] = useState('')
  const [value, setValue] = useState('')
  return (
    <Section title={<Bilingual main={W.addAsset.en} sub={yo('addAsset')} />}>
      <Card className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {TYPES.map(([k, label]) => (
            <button key={k} onClick={() => setType(k)} aria-pressed={type === k}
              className={`min-h-11 rounded-full px-4 text-base font-medium ${type === k ? 'bg-accent text-on-accent' : 'bg-fill text-label'}`}>{label}</button>
          ))}
        </div>
        <TextField label="What is it?" value={desc} onChange={setDesc} placeholder="Stall stock, tomatoes" maxLength={120} />
        <p className="text-base font-medium">Roughly what is it worth?</p>
        <div className="py-1 text-center"><AmountDisplay text={naira(BigInt(value || '0') * 100n)} size="lg" className={value ? '' : 'text-secondary'} /></div>
        <NumPad onKey={(k) => setValue(applyKey(value, k, 8))} />
        <div className="grid grid-cols-2 gap-3">
          <Button variant="plain" onClick={() => onDone(null)}>Cancel</Button>
          <Button loading={busy} disabled={desc.trim().length < 2 || !value} onClick={async () => {
            const r = await run('register_asset', { type, description: desc, value })
            if (r.ok) onDone(String((r.asset as Row).id))
          }}>Add</Button>
        </div>
      </Card>
    </Section>
  )
}

// ---------------------------------------------------------------------------- witness requests

/** People who asked her to confirm their asset. Also on Home when any are waiting. */
export function WitnessRequests({ version, compact = false }: { version: number; compact?: boolean }) {
  const [bump, setBump] = useState(0)
  const [r, setR] = useState<ToolResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void tool('witness_requests').then((x) => live && setR(x)).catch(() => undefined)
    return () => { live = false }
  }, [version, bump])
  const list = (r?.requests ?? []) as Row[]
  if (list.length === 0) return done ? <Notice tone="success">{done}</Notice> : null
  async function answer(id: string, confirm: boolean) {
    setBusy(id)
    const x = await tool('answer_witness', { request_id: id, confirm }).catch(() => ({ ok: false, text: 'No connection. Try again.' }) as ToolResult)
    setBusy(null)
    setDone(forScreen(x.text))
    setBump((b) => b + 1)
  }
  return (
    <div className="space-y-3">
      {list.map((q) => (
        <Card key={String(q.id)} className="space-y-3 border border-info/30">
          <p className="flex items-center gap-2 text-sm font-medium text-info"><Icon name="shield" /> <Bilingual main={W.confirmForThem.en} sub={yo('confirmForThem')} /></p>
          {!compact && q.photo_url ? <img src={String(q.photo_url)} alt={String(q.description)} className="aspect-[4/3] w-full rounded-control object-cover" /> : null}
          <p className="text-xl font-medium">{String(q.owner_name)}: {String(q.description)}</p>
          <p className="text-base text-secondary">About {String(q.value_text)}. Only say yes if you have seen it yourself and you know it is theirs.</p>
          <div className="grid grid-cols-2 gap-3">
            <Button variant="plain" loading={busy === q.id} onClick={() => void answer(String(q.id), false)}>{W.cantConfirm.en}</Button>
            <Button loading={busy === q.id} onClick={() => void answer(String(q.id), true)}>{W.iConfirm.en}</Button>
          </div>
        </Card>
      ))}
      {done && <Notice tone="success">{done}</Notice>}
    </div>
  )
}

// ---------------------------------------------------------------------------- the screen

export function Assets({ version }: { version: number }) {
  const [bump, setBump] = useState(0)
  const [r, setR] = useState<ToolResult | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [camera, setCamera] = useState<PhotoAsk | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  useEffect(() => {
    let live = true
    void tool('my_assets').then((x) => live && setR(x)).catch(() => live && setR({ ok: false, text: 'No connection.', error: 'network' }))
    return () => { live = false }
  }, [version, bump])
  const list = ((r?.assets ?? []) as Row[]).filter((a) => a.status !== 'released')
  const current = list.find((a) => a.id === sel) ?? null

  async function run(name: string, args: Row) {
    setBusy(true)
    setMsg(null)
    const x = await tool(name, args).catch(() => ({ text: 'No connection. Try again.', ok: false }) as ToolResult)
    setBusy(false)
    setMsg({ tone: x.ok ? 'success' : 'danger', text: forScreen(x.text) })
    if (x.ok) setBump((b) => b + 1)
    return x
  }

  // The voice agent's take_photo opens the camera here.
  const listRef = useRef(list)
  listRef.current = list
  useEffect(() => {
    photoListener = (ask) => {
      const open = listRef.current
      const q = (ask.asset ?? '').toLowerCase()
      const a = open.find((x) => x.id === ask.asset) ?? (q ? open.find((x) => String(x.description).toLowerCase().includes(q)) : null) ?? (open.length === 1 ? open[0] : null)
      if (!a) return ask.resolve(open.length ? `Which asset? ${open.map((x) => String(x.description)).join('; ')}.` : 'She has no assets yet. Register one first.')
      setAdding(false)
      setSel(String(a.id))
      setCamera(ask)
    }
    return () => { photoListener = null }
  }, [])

  async function shot(jpeg: string, lat: number | null, lon: number | null) {
    const ask = camera
    setCamera(null)
    const x = await run('asset_photo', { asset_id: sel, photo: jpeg, lat, lon })
    ask?.resolve(x.text)
  }

  useSays(
    current
      ? `Asset: ${String(current.description)}, ${String(current.value_text)}. Level: ${String(current.level_text)}. ${String(current.next_text ?? '')}${camera ? ' The camera is open; she taps Take the photo.' : ''}`
      : adding ? 'Adding an asset: she picks the kind, types what it is, and its rough value.'
      : `Assets. ${list.length ? list.map((a) => `${String(a.description)}: ${String(a.level_text)}`).join('; ') : 'None yet.'} Button: Add something you own.`,
  )

  if (!r) return <LoadingList rows={3} />
  return (
    <div className="space-y-5">
      <WitnessRequests version={version + bump} />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {current ? (
        camera ? <Camera onShot={(j, la, lo) => void shot(j, la, lo)} onCancel={() => { camera.resolve('She cancelled the photo.'); setCamera(null) }} />
          : <AssetView a={current} run={run} busy={busy} onBack={() => { setSel(null); setMsg(null) }} onPhoto={() => setCamera({ resolve: () => undefined })} />
      ) : adding ? (
        <Register run={run} busy={busy} onDone={(id) => { setAdding(false); if (id) setSel(id) }} />
      ) : (
        <>
          {list.length === 0 ? (
            <EmptyState icon="assets" title="Nothing yet">Stock, tools, a machine, a motorcycle or livestock you use for your business. Verified assets help your loan.</EmptyState>
          ) : (
            <ListGroup>
              {list.map((a) => (
                <ListRow key={String(a.id)} icon={TYPE_ICON[String(a.type)] ?? 'assets'} iconTone={a.level === 'independently_verified' ? 'success' : 'neutral'}
                  title={String(a.description)}
                  subtitle={`${String(a.value_text)} · ${a.status === 'active' ? String(a.level_text) : String(a.status_text)}`}
                  chevron onClick={() => { setSel(String(a.id)); setMsg(null) }} />
              ))}
            </ListGroup>
          )}
          <Button variant="secondary" className="w-full" onClick={() => { setAdding(true); setMsg(null) }}><Icon name="add" /> {W.addAsset.en}</Button>
          <p className="px-1 text-sm text-secondary">Only active, verified assets count toward a loan. Photos are private: only the people checking them see them.</p>
        </>
      )}
    </div>
  )
}

