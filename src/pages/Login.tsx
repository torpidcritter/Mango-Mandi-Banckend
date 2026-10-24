import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, api } from '../api'
import { useSession } from '../session'
import type { Me, SignInResult } from '../types'
import { FormError, usePageTitle } from '../ui'
import { GoogleSignIn } from '../google'

export default function Login() {
  usePageTitle('Sign in')
  const { me, setMe } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [ticket, setTicket] = useState<string | null>(null)

  // Only a path on this site (SEC-11): "//host" and "/\host" would be another site.
  const asked = (location.state as { from?: string } | null)?.from
  const from = asked && /^\/(?![/\\])/.test(asked) ? asked : '/'
  if (me) return <Navigate to={from} replace />

  function done(signedIn: Me) {
    setMe(signedIn)
    navigate(from, { replace: true })
  }
  function afterFirstStep(r: SignInResult) {
    if ('me' in r) return done(r.me)
    setError(null)
    setTicket(r.ticket)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      afterFirstStep(await api.login(email.trim(), password))
    } catch (err) {
      // Never say which field was wrong.
      setError(err instanceof ApiError && (err.status === 401 || err.status === 400) ? 'Invalid credentials' : err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-wrap">
      <div className="card login-card">
        <img src="/brand/logo-320.webp" srcSet="/brand/logo-320.webp 1x, /brand/logo-640.webp 2x" width="112" height="112" alt="MandiMangoes" className="login-logo" />
        <h1>Mango Ops</h1>
        {ticket ? (
          <CodeStep
            ticket={ticket}
            onDone={done}
            onRestart={() => {
              setTicket(null)
              setPassword('')
            }}
          />
        ) : (
          <>
            {params.get('reason') === 'expired' && (
              <div className="notice notice-warn" role="status">
                Your session has ended. Please sign in again.
              </div>
            )}
            <GoogleSignIn onSignedIn={afterFirstStep} onError={setError} />
            <form onSubmit={onSubmit} noValidate>
              <div className="field">
                <label htmlFor="email">Work email</label>
                <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <FormError error={error} />
              <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}

/** The second step: the 6-digit code from the authenticator app, or a recovery code. */
function CodeStep({ ticket, onDone, onRestart }: { ticket: string; onDone: (me: Me) => void; onRestart: () => void }) {
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const expired = error instanceof ApiError && error.code === 'TICKET_EXPIRED'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onDone(await api.twoStep(ticket, code.trim()))
    } catch (err) {
      setError(err)
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  const ready = recovery ? /^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code.trim()) : /^\d{6}$/.test(code.trim())
  return (
    <form onSubmit={submit} noValidate>
      <h2>Two-step sign-in</h2>
      <p className="muted">
        {recovery
          ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each works once.'
          : 'Open your authenticator app and enter the 6-digit code for MandiMangoes Ops.'}
      </p>
      <div className="field">
        <label htmlFor="two-step-code">{recovery ? 'Recovery code' : '6-digit code'}</label>
        <input
          id="two-step-code"
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          maxLength={recovery ? 9 : 6}
          value={code}
          onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
      </div>
      <FormError error={error} />
      {expired ? (
        <button type="button" className="btn btn-primary" onClick={onRestart}>
          Sign in again
        </button>
      ) : (
        <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      )}
      <p className="small">
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setRecovery((r) => !r)
            setCode('')
            setError(null)
          }}
        >
          {recovery ? 'Use the app instead' : 'Lost your phone? Use a recovery code'}
        </button>
      </p>
    </form>
  )
}
