// Reads box labels three ways: the camera (the browser's BarcodeDetector where
// it exists, else jsQR, so iPhones work too), a handheld scanner (it types the
// QR text and Enter into the box), or a code typed by hand (ORD-1042-2).
import { useEffect, useRef, useState, type FormEvent } from 'react'

interface Props {
  /** Called with what was read. Return a promise; the next scan waits for it. */
  onScan: (text: string) => Promise<void>
  label?: string
  disabled?: boolean
}

interface Detector {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector

const REPEAT_MS = 2500

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

export default function Scanner({ onScan, label = 'Scan or type the label code', disabled }: Props) {
  const [text, setText] = useState('')
  const [camera, setCamera] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const busy = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function submit(value: string) {
    const v = value.trim()
    if (!v || busy.current) return
    busy.current = true
    try {
      await onScan(v)
    } finally {
      busy.current = false
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const v = text
    setText('')
    await submit(v)
    inputRef.current?.focus()
  }

  return (
    <div className="scanner">
      <form onSubmit={onSubmit} className="btn-row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label htmlFor="scan-input">{label}</label>
          <input
            id="scan-input"
            ref={inputRef}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ORD-1042-2"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            data-autofocus
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>
          Check
        </button>
        {cameraSupported() && (
          <button type="button" className="btn" aria-pressed={camera} onClick={() => setCamera(!camera)} disabled={disabled}>
            {camera ? 'Stop camera' : 'Use camera'}
          </button>
        )}
      </form>
      {cameraError && <p className="text-warn small">{cameraError}</p>}
      {camera && <Camera onRead={submit} onError={(m) => (setCameraError(m), setCamera(false))} />}
    </div>
  )
}

function Camera({ onRead, onError }: { onRead: (text: string) => Promise<void>; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const readRef = useRef(onRead)
  readRef.current = onRead
  const errorRef = useRef(onError)
  errorRef.current = onError

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    let timer = 0
    const last = { text: '', at: 0 }
    const canvas = document.createElement('canvas')

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      } catch {
        errorRef.current('The camera could not be opened. Allow camera access, or type the code instead.')
        return
      }
      if (stopped || !video.current) return
      video.current.srcObject = stream
      await video.current.play().catch(() => {})
      const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
      const detector = Ctor ? new Ctor({ formats: ['qr_code'] }) : null
      // jsQR is only downloaded on phones without BarcodeDetector (iPhone Safari, Firefox).
      const jsQR = detector ? null : (await import('jsqr')).default

      async function tick() {
        if (stopped || !video.current) return
        const v = video.current
        let found: string | null = null
        try {
          if (v.readyState >= 2) {
            if (detector) {
              found = (await detector.detect(v))[0]?.rawValue ?? null
            } else if (jsQR) {
              canvas.width = v.videoWidth
              canvas.height = v.videoHeight
              const ctx = canvas.getContext('2d', { willReadFrequently: true })
              if (ctx && canvas.width) {
                ctx.drawImage(v, 0, 0)
                const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
                found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null
              }
            }
          }
        } catch {
          found = null
        }
        // The same QR held in front of the camera is read once, not every frame.
        if (found && (found !== last.text || Date.now() - last.at > REPEAT_MS)) {
          last.text = found
          last.at = Date.now()
          await readRef.current(found)
        }
        if (!stopped) timer = window.setTimeout(tick, 200)
      }
      tick()
    }
    start()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="scan-camera">
      <video ref={video} muted playsInline aria-label="Camera view: hold the label's QR code in the frame" />
    </div>
  )
}
