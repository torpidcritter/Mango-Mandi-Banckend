import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { week } from '../format'

/** Shop home: shown while any week is open for booking. Its own file, so the home page does not load the whole booking page. */
export function BookAheadCard() {
  const q = useQuery({ queryKey: ['preorder-weeks'], queryFn: api.preorderWeeks, staleTime: 60_000 })
  const weeks = [...new Set(q.data?.weeks.map((w) => w.weekStart) ?? [])]
  if (!weeks.length) return null
  return (
    <section className="card book-ahead" aria-labelledby="book-ahead">
      <h2 id="book-ahead">Book ahead</h2>
      <p>
        Lock in today's price for the week of {week(weeks[0])}
        {weeks.length > 1 && ' or later'}. We pick your delivery day that week once the fruit is in.
      </p>
      <Link to="/preorder" className="btn btn-primary">
        Book a box ahead
      </Link>
    </section>
  )
}
