// Two-step sign-in for staff: set it up with an authenticator app, save the
// recovery codes, or turn it off where the role does not require it.
import { useEffect, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { api } from '../api'
import { useSession } from '../session'
import { FormError } from '../ui'

/** Shown instead of the panel when the role must use two-step sign-in and it is not set up yet. */
export function TwoStepGate() {
  return (
    <main className="setup-wrap">
      <div className="card">
        <h1>Set up two-step sign-in</h1>
        <p>
          Managers sign in with a code from an authenticator app as well as their password. It keeps orders, stock and staff safe if a password
          leaks. This takes about a minute.
        </p>
        <Setup />
        <p className="small">
          <button type="button" className="link-btn" onClick={() => void api.logout()}>
            Sign out
          </button>
        </p>
      </div>
    </main>
  )
}

export default function TwoStepPage() {
  const { me } = useSession()
  const on = me?.twoStep?.enabled
  return (
    <section className="card" style={{ maxWidth: 640 }}>
      <h1>Two-step sign-in</h1>
      {on ? (
        <>
          <p>
            <strong>On.</strong> You sign in with your password or Google, then a code from your authenticator app.
          </p>
          {me?.twoStep?.required ? (
            <p className="muted">Your role must use two-step sign-in. If you lose your phone, use a recovery code or ask a manager to reset it.</p>
          ) : (
            <TurnOff />
          )}
        </>
      ) : (
        <>
          <p>
            <strong>Off.</strong> Add a code from an authenticator app (Google Authenticator, Microsoft Authenticator or 1Password) to your
            sign-in.
          </p>
          <Setup />
        </>
      )}
    </section>
  )
}

function Setup() {
  const { setMe } = useSession()
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!secret) return
    let live = true
    QRCode.toDataURL(secret.otpauthUrl, { margin: 1, width: 200 }).then((u) => live && setQr(u), () => live && setQr(null))
    return () => {
      live = false
    }
  }, [secret])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      setSecret(await api.twoStepSetup())
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  async function confirm(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setCodes(await api.twoStepEnable(code))
    } catch (err) {
      setError(err)
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  async function finish() {
    setMe(await api.me())
  }

  if (codes) {
    const text = `MandiMangoes Ops recovery codes\nEach code works once, if you lose your phone.\n\n${codes.join('\n')}\n`
    return (
      <div>
        <h2>Save your recovery codes</h2>
        <p>If you lose your phone, each of these lets you sign in once. Keep them somewhere safe, away from your phone. They are not shown again.</p>
        <ul className="recovery-codes" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <a className="btn" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="mandimangoes-recovery-codes.txt">
            Download codes
          </a>
          <button type="button" className="btn btn-primary" onClick={() => void finish()}>
            I've saved them
          </button>
        </div>
      </div>
    )
  }
  if (!secret) {
    return (
      <>
        <FormError error={error} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Set up two-step sign-in'}
        </button>
      </>
    )
  }
  return (
    <form onSubmit={confirm} noValidate>
      <ol>
        <li>Open your authenticator app and add an account.</li>
        <li>
          Scan this code, or type the key below.
          {qr && <img className="qr" src={qr} alt="QR code for your authenticator app" />}
          <div className="small">
            Key: <span className="secret-key">{secret.secret.match(/.{1,4}/g)?.join(' ')}</span>
          </div>
        </li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="field">
        <label htmlFor="setup-code">6-digit code</label>
        <input
          id="setup-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <FormError error={error} />
      <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Turn on'}
      </button>
    </form>
  )
}

function TurnOff() {
  const { setMe } = useSession()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.twoStepDisable(code)
      setMe(await api.me())
    } catch (err) {
      setError(err)
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="off-code">To turn it off, enter a code from the app</label>
        <input id="off-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      <FormError error={error} />
      <button type="submit" className="btn btn-danger" disabled={busy || code.length !== 6}>
        {busy ? 'Turning off…' : 'Turn off two-step sign-in'}
      </button>
    </form>
  )
}
