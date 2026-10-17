import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { GoogleButton, PhoneCodeForm } from '../auth-ui'
import { useStore } from '../store'

export default function SignIn() {
  const { profile } = useStore()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next')?.startsWith('/') ? params.get('next')! : '/'
  const [googleError, setGoogleError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (profile && !done) return <Navigate to={next} replace />
  const finish = () => {
    setDone(true)
    navigate(next, { replace: true })
  }

  return (
    <section className="card narrow">
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
