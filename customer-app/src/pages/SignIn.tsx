import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { GoogleButton, PhoneCodeForm } from '../auth-ui'
import { safeNext } from '../next'
import { useStore } from '../store'

export default function SignIn() {
  const { profile } = useStore()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const [googleError, setGoogleError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (profile && !done) return <Navigate to={next} replace />
  const finish = () => {
    setDone(true)
    navigate(next, { replace: true })
  }

  return (
    <section className="card narrow">
      <img src="/brand/logo-320.webp" srcSet="/brand/logo-320.webp 1x, /brand/logo-640.webp 2x" width="96" height="96" alt="MandiMangoes" className="signin-logo" />
      <h1>Sign in</h1>
      <GoogleButton onSignedIn={finish} onError={setGoogleError} />
      {googleError && (
        <p className="field-error" role="alert">
          {googleError}
        </p>
      )}
      <PhoneCodeForm mode="signin" onDone={finish} />
      <p className="small muted consent">
        By continuing you agree to how we use your details, set out in our <Link to="/privacy">privacy notice</Link>.
      </p>
    </section>
  )
}
