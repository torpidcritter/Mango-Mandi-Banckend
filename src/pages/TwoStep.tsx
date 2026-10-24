// Two-step sign-in for staff: set it up with an authenticator app, save the
// recovery codes, or turn it off where the role does not require it.
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useSession } from '../session'
import { FormError, usePageTitle, useToast } from '../ui'

/** Shown instead of the panel when the role must use two-step sign-in and it is not set up yet. */
export function TwoStepGate() {
  usePageTitle('Set up two-step sign-in')
  return (
    <main className="setup-wrap">
      <div className="card">
        <h1>Set up two-step sign-in</h1>
        <p>
          Your role signs in with a code from an authenticator app as well as a password. It keeps orders, stock and customers' details safe if a
          password leaks. This takes about a minute.
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
  usePageTitle('Two-step sign-in')
  const { me } = useSession()
  const on = me?.twoStep?.enabled
  return (
    <>
      <section className="card narrow">
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
      <ChangePassword />
    </>
  )
}

/** Your own password (SEC-09): the current one, then a new one of 12 characters or more. */
function ChangePassword() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [problem, setProblem] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next.length < 12) return setProblem('Use a new password of at least 12 characters.')
    setProblem(null)
    setBusy(true)
    setError(null)
    try {
      await api.changePassword(current, next)
      setCurrent('')
      setNext('')
      toast.success('Password changed. You are signed out on your other devices.')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card narrow" aria-labelledby="pw-title">
      <h2 id="pw-title">Your password</h2>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-new-hint" />
          <p className="hint" id="pw-new-hint">
            At least 12 characters, and not a common password. A few words only you would put together work well.
          </p>
        </div>
        {problem && (
          <p role="alert" className="text-danger">
            {problem}
          </p>
        )}
        <FormError error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy || !current || !next}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  )
}

function Setup() {
  const { me, setMe } = useSession()
  const needsCode = Boolean(me?.twoStep?.setupCodeNeeded)
  const [setupCode, setSetupCode] = useState('')
  const [secret, setSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (!secret) return
    let live = true
    // The QR library is loaded only here, when someone sets up two-step sign-in.
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(secret.otpauthUrl, { margin: 1, width: 200 }))
      .then((u) => live && setQr(u), () => live && setQr(null))
    return () => {
      live = false
    }
  }, [secret])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      setSecret(await api.twoStepSetup(needsCode ? setupCode.trim() : undefined))
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
        <div className="btn-row">
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
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
        noValidate
      >
        {needsCode && (
          <div className="field">
            <label htmlFor="setup-code-from-manager">Setup code from your manager</label>
            <input
              id="setup-code-from-manager"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={9}
              value={setupCode}
              aria-describedby="setup-code-hint"
              onChange={(e) => setSetupCode(e.target.value)}
            />
            <p className="hint" id="setup-code-hint">
              Like k7qd-2mxp. A manager gives you one when they add you or reset your two-step sign-in.
            </p>
          </div>
        )}
        <FormError error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy || (needsCode && setupCode.trim().length < 8)}>
          {busy ? 'Starting…' : 'Set up two-step sign-in'}
        </button>
      </form>
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
