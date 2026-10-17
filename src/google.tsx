// "Sign in with Google" for staff: Google's button, shown only when the API has
// a Google client ID. The API accepts it when the Google email is a staff email.
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { SignInResult } from './types'

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; context?: string }) => void
          renderButton: (el: HTMLElement, o: Record<string, unknown>) => void
        }
      }
    }
  }
}

let script: Promise<void> | null = null
function loadGoogle() {
  script ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      script = null
      reject(new Error('Could not load Google sign-in.'))
    }
    document.head.appendChild(s)
  })
  return script
}

export function GoogleSignIn({ onSignedIn, onError }: { onSignedIn: (r: SignInResult) => void; onError: (err: unknown) => void }) {
  const [clientId, setClientId] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onSignedIn, onError })
  handlers.current = { onSignedIn, onError }

  useEffect(() => {
    let live = true
    api.authConfig().then((c) => live && setClientId(c.googleClientId), () => undefined)
    return () => {
      live = false
    }
  }, [])

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
            void api.loginWithGoogle(credential).then(
              (r) => handlers.current.onSignedIn(r),
              (err) => handlers.current.onError(err),
            ),
        })
        window.google.accounts.id.renderButton(box.current, { theme: 'outline', size: 'large', text: 'signin_with', width: 300 })
      })
      .catch((err) => live && handlers.current.onError(err))
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
