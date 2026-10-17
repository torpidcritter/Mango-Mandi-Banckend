import { Link } from 'react-router-dom'
import { homeFor } from '../permissions'
import { useSession } from '../session'

export default function NotFound({ notAllowed = false }: { notAllowed?: boolean }) {
  const { me } = useSession()
  return (
    <div className="card">
      <h1>{notAllowed ? 'Not available for your role' : 'Page not found'}</h1>
      <p className="muted">
        {notAllowed ? 'Ask a manager if you need this screen.' : "That address doesn't match any screen."}
      </p>
      <Link to={homeFor(me?.role)} className="btn btn-primary">
        Go to your home screen
      </Link>
    </div>
  )
}
