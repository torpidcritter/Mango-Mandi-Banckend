// Sign-in pieces shared by the sign-in page, checkout and booking ahead:
// the "Sign in with Google" button and the mobile number + code form.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, errorMessage } from './api'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup'; context?: string }) => void
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void
        }
      }
    }
  }
}

let gis: Promise<void> | null = null
function loadGoogle() {
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      gis = null
      reject(new Error('Could not load Google sign-in.'))
    }
    document.head.appendChild(s)
  })
  return gis
}

/** Google's own button. Renders nothing until the API says Google sign-in is set up. */
export function GoogleButton({ onSignedIn, onError }: { onSignedIn: () => void; onError: (message: string) => void }) {
  const config = useQuery({ queryKey: ['auth-config'], queryFn: api.authConfig, staleTime: Infinity, retry: false })
  const box = useRef<HTMLDivElement>(null)
  const clientId = config.data?.googleClientId ?? null
  const done = useRef({ onSignedIn, onError })
  done.current = { onSignedIn, onError }

  useEffect(() => {
    if (!clientId || !box.current) return
    let live = true
    loadGoogle()
      .then(() => {
        if (!live || !box.current || !window.google) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          context: 'signin',
          callback: ({ credential }) =>
            void api.signInWithGoogle(credential).then(
              () => done.current.onSignedIn(),
              (err) => done.current.onError(errorMessage(err)),
            ),
        })
        window.google.accounts.id.renderButton(box.current, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text: 'continue_with',
          width: Math.min(box.current.clientWidth || 320, 400),
        })
      })
      .catch((err: Error) => live && done.current.onError(err.message))
    return () => {
      live = false
    }
  }, [clientId])

  if (!clientId) return null
  return (
    <>
      <div ref={box} className="google-btn" />
      <p className="or" aria-hidden="true">
        <span>or</span>
      </p>
    </>
  )
}

const tenDigits = (s: string) => s.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '')

/**
 * Mobile number, then the 6-digit code. "signin" signs in with the number;
 * "add" adds a checked number to the signed-in (Google) account.
 */
export function PhoneCodeForm({ mode, onDone, intro }: { mode: 'signin' | 'add'; onDone: () => void; intro?: string }) {
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<{ channel: 'sms' | 'whatsapp'; devCode?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const request = useMutation({
    mutationFn: (channel?: 'sms' | 'whatsapp') =>
      mode === 'signin' ? api.requestCode(tenDigits(phone), channel) : api.requestPhoneCode(tenDigits(phone), channel),
    onSuccess: (r) => {
      setSent(r)
      setCode('')
      setError(null)
    },
    onError: (err) => setError(errorMessage(err)),
  })
  const verify = useMutation({
    mutationFn: () => (mode === 'signin' ? api.verifyCode(tenDigits(phone), code) : api.verifyPhoneCode(tenDigits(phone), code)),
    onSuccess: onDone,
    onError: (err) => setError(errorMessage(err)),
  })

  function sendCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^[6-9]\d{9}$/.test(tenDigits(phone))) return setError('Enter your 10-digit mobile number.')
    request.mutate(undefined)
  }
  function checkCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code.')
    verify.mutate()
  }
  const errorNote = error && (
    <p id="phone-error" className="field-error" role="alert">
      {error}
    </p>
  )

  if (!sent) {
    return (
      <form onSubmit={sendCode} noValidate>
        <p className="muted">{intro ?? "We'll send a 6-digit code to your phone. No password needed."}</p>
        <div className="field">
          <label htmlFor="phone">Mobile number</label>
          <div className="prefixed">
            <span aria-hidden="true">+91</span>
            <input
              id="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={14}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-describedby={error ? 'phone-error' : undefined}
            />
          </div>
        </div>
        {errorNote}
        <button type="submit" className="btn btn-primary btn-block" disabled={request.isPending}>
          {request.isPending ? 'Sending…' : 'Send code'}
        </button>
      </form>
    )
  }
  return (
    <form onSubmit={checkCode} noValidate>
      <p className="muted">
        We sent a code by {sent.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} to +91 {tenDigits(phone)}.{' '}
        <button type="button" className="link-btn" onClick={() => setSent(null)}>
          Change number
        </button>
      </p>
      {sent.devCode && <p className="note">Test mode: your code is {sent.devCode}.</p>}
      <div className="field">
        <label htmlFor="code">6-digit code</label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-describedby={error ? 'phone-error' : undefined}
        />
      </div>
      {errorNote}
      <button type="submit" className="btn btn-primary btn-block" disabled={verify.isPending}>
        {verify.isPending ? 'Checking…' : mode === 'signin' ? 'Sign in' : 'Add number'}
      </button>
      <div className="resend">
        <button type="button" className="link-btn" disabled={request.isPending} onClick={() => request.mutate('sms')}>
          Send again by SMS
        </button>
        <button type="button" className="link-btn" disabled={request.isPending} onClick={() => request.mutate('whatsapp')}>
          Send on WhatsApp instead
        </button>
      </div>
    </form>
  )
}

/** Shown before checkout or booking when the account (made with Google) has no mobile number yet. */
export function AddPhoneCard() {
  return (
    <section className="card narrow" aria-labelledby="add-phone">
      <h1 id="add-phone">Add your mobile number</h1>
      <PhoneCodeForm
        mode="add"
        onDone={() => undefined}
        intro="The rider calls this number, and your order updates come to it on WhatsApp. We'll send a code to check it."
      />
    </section>
  )
}
