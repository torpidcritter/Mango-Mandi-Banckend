// The page behind the QR code on a MandiMangoes box: what is inside and when to
// eat it. Anyone can open it (no sign-in); it shows nothing about the order or
// who it was for, and an unknown or old code gets the same friendly page.
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { STAGE_LABEL, day } from '../format'
import { CARE, MangoArt } from '../mango'

export default function Box() {
  const { token = '' } = useParams()
  const q = useQuery({ queryKey: ['box', token], queryFn: () => api.box(token), retry: false })

  if (q.isPending) return <p className="muted">Looking up your box…</p>
  const b = q.data
  if (q.isError || !b?.found) {
    return (
      <section className="card">
        <h1>Mangoes from MandiMangoes</h1>
        <p>We couldn't find this box. The label may be old or damaged.</p>
        <p>Keep raw mangoes at room temperature until they smell sweet and give a little when pressed. Move ripe ones to the fridge.</p>
        <Link to="/" className="btn btn-primary">
          See today's mangoes
        </Link>
      </section>
    )
  }
  const care = CARE[b.stage]
  return (
    <>
      <section className="card box-hero">
        <MangoArt stage={b.stage} size={72} label={`${STAGE_LABEL[b.stage]} mango`} />
        <div>
          <h1>{b.productName}</h1>
          {b.description && <p>{b.description}</p>}
          <dl className="kv">
            <dt>Plucked</dt>
            <dd>{day(b.pluckedOn)}</dd>
            <dt>Ripeness on delivery</dt>
            <dd>{STAGE_LABEL[b.stage]}</dd>
            <dt>Ready to eat</dt>
            <dd>{b.stage === 'RIPE' ? 'Now' : `From about ${day(b.readyFrom)}`}</dd>
            <dt>Best eaten by</dt>
            <dd>{day(b.eatBy)}</dd>
          </dl>
          <p className="small muted">Dates are a guide: a warm kitchen ripens mangoes faster, a cool one slower.</p>
        </div>
      </section>
      <section className="card" aria-labelledby="box-care">
        <h2 id="box-care">{care.title}: how to look after them</h2>
        <ul>
          {care.tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <Link to="/" className="btn">
          Order more mangoes
        </Link>
      </section>
    </>
  )
}
