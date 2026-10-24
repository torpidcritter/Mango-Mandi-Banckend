// Products: managers add boxes to the shop, rename or reprice them, and take
// them off sale. The shop, WhatsApp ordering, batches and preorders all read
// this list, so nothing else needs changing when a product is added.
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_URL, api } from '../api'
import { shrinkPhoto } from '../photo'
import { rupees } from '../format'
import type { Product, ProductInput } from '../types'
import { Badge, ConfirmDialog, Dialog, EmptyState, FormError, QueryError, Spinner, useToast, scrollRegion, usePageTitle } from '../ui'

export default function Products() {
  usePageTitle('Products')
  const toast = useToast()
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['products'], queryFn: api.products })
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [removing, setRemoving] = useState<Product | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['products'] })

  const restore = useMutation({
    mutationFn: (p: Product) => api.updateProduct(p.sku, { active: true }),
    onSuccess: (p) => {
      toast.success(`${p.name} is back on sale`)
      refresh()
    },
    onError: (err) => toast.error(err),
  })
  const remove = useMutation({
    mutationFn: (p: Product) => api.removeProduct(p.sku),
    onSuccess: (r) => {
      const name = removing?.name ?? r.sku
      toast.success(r.outcome === 'deleted' ? `${name} deleted` : `${name} taken off sale`)
      setRemoving(null)
      refresh()
    },
  })

  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => Number(b.active !== false) - Number(a.active !== false)), [q.data])
  const varieties = useMemo(() => Array.from(new Set((q.data ?? []).map((p) => p.variety).filter(Boolean))).sort(), [q.data])

  return (
    <>
      <div className="topbar">
        <h1>Products</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add product
        </button>
      </div>
      <section className="card">
        {q.isPending ? (
          <Spinner label="Loading products" />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <EmptyState>No products yet. Add the first box you sell.</EmptyState>
        ) : (
          <div {...scrollRegion('Products')}>
            <table>
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Photo</span>
                  </th>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Variety</th>
                  <th>Box</th>
                  <th className="num">Price</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const onSale = p.active !== false
                  return (
                    <tr key={p.sku} className={onSale ? undefined : 'muted'}>
                      <td>
                        <ProductThumb product={p} />
                      </td>
                      <td>
                        <strong>{p.name}</strong>
                        {p.description && <div className="small muted">{p.description}</div>}
                      </td>
                      <td>
                        <code>{p.sku}</code>
                      </td>
                      <td>{p.variety}</td>
                      <td>{p.boxSize}</td>
                      <td className="num">{p.price != null ? rupees(p.price) : ''}</td>
                      <td>{onSale ? <Badge tone="good">On sale</Badge> : <Badge>Removed</Badge>}</td>
                      <td className="actions">
                        <button type="button" className="btn btn-small" onClick={() => setEditing(p)}>
                          Edit<span className="sr-only"> {p.name}</span>
                        </button>{' '}
                        {onSale ? (
                          <button type="button" className="btn btn-small" onClick={() => setRemoving(p)}>
                            Remove<span className="sr-only"> {p.name}</span>
                          </button>
                        ) : (
                          <button type="button" className="btn btn-small" disabled={restore.isPending} onClick={() => restore.mutate(p)}>
                            Put back on sale<span className="sr-only"> {p.name}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          Prices include GST. A new price applies from the next checkout; orders already placed keep theirs. A rename shows everywhere, past
          orders included.
        </p>
      </section>

      {editing && (
        <ProductDialog product={editing === 'new' ? null : editing} varieties={varieties} onClose={() => setEditing(null)} onDone={refresh} />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          tone="danger"
          confirmLabel="Remove product"
          cancelLabel="Keep it"
          busy={remove.isPending}
          error={remove.error}
          onClose={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing)}
        >
          <p>Customers stop seeing it in the shop and on WhatsApp, and it can't be added to new batches or preorders.</p>
          <p className="small muted">
            If it has never been stocked or sold, it is deleted. Otherwise it is kept as removed, so past orders and batches keep its name, and you
            can put it back on sale later. Orders already placed are not affected.
          </p>
        </ConfirmDialog>
      )}
    </>
  )
}

const toForm = (p: Product | null) => ({
  sku: p?.sku ?? '',
  name: p?.name ?? '',
  variety: p?.variety ?? '',
  boxSize: p?.boxSize ?? '',
  price: p?.price != null ? String(p.price / 100) : '',
  description: p?.description ?? '',
  sortOrder: String(p?.sortOrder ?? 0),
  gst: String(Math.round((p?.gstRate ?? 0) * 10_000) / 100),
  hsnCode: p ? (p.hsnCode ?? '') : '08045020',
  fruitsPerBox: p?.fruitsPerBox != null ? String(p.fruitsPerBox) : '',
  fruitWeightG: p?.fruitWeightG != null ? String(p.fruitWeightG) : '',
})

type SaveInput = ProductInput & { sku: string; reason?: string }

/** "" → null; otherwise a whole number in range, or undefined when it is not one. */
function optionalWhole(v: string, min: number, max: number): number | null | undefined {
  if (!v.trim()) return null
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

function ProductDialog({ product, varieties, onClose, onDone }: { product: Product | null; varieties: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [f, setF] = useState(() => toForm(product))
  const [formError, setFormError] = useState<string | null>(null)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  // The photo is sent after the product is saved (a new product needs its SKU first).
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [dropPhoto, setDropPhoto] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const preview = useObjectUrl(photo)
  // ADM-2: a new price waits on this confirmation, which shows the old and new price and takes an optional reason.
  const [confirmPrice, setConfirmPrice] = useState<SaveInput | null>(null)
  const [reason, setReason] = useState('')
  const current = !dropPhoto && product?.photoUrl ? `${API_URL}${product.photoUrl}` : null
  async function pickPhoto(file: File | undefined) {
    setPhotoError(null)
    if (!file) return
    try {
      setPhoto(await shrinkPhoto(file))
      setDropPhoto(false)
    } catch {
      setPhotoError('That file is not a photo. Choose a JPEG, PNG or WebP image.')
    }
  }
  const save = useMutation({
    mutationFn: async ({ sku, reason: why, ...input }: SaveInput) => {
      let saved = product ? await api.updateProduct(product.sku, why ? { ...input, reason: why } : input) : await api.addProduct({ sku, ...input })
      if (photo) saved = await api.setProductPhoto(saved.sku, photo)
      else if (dropPhoto && product?.photoUrl) saved = await api.removeProductPhoto(saved.sku)
      return saved
    },
    onSuccess: (p) => {
      toast.success(product ? `${p.name} saved` : `${p.name} added to the shop`)
      onDone()
      onClose()
    },
    // A new product that saved but whose photo failed still shows up in the list.
    onError: () => onDone(),
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const sku = f.sku.trim().toUpperCase()
    if (!product && !/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(sku)) return setFormError('Use 2 to 20 letters, digits and dashes for the SKU, like KES-3.')
    if (f.name.trim().length < 2) return setFormError('Give the product a name.')
    if (f.variety.trim().length < 2) return setFormError('Give the variety, like Kesar.')
    const price = Number(f.price)
    if (!(price > 0)) return setFormError('Enter the price in rupees.')
    const gst = Number(f.gst || 0)
    if (!(gst >= 0 && gst <= 28)) return setFormError('GST is a percentage from 0 to 28.')
    const hsn = f.hsnCode.trim()
    if (hsn && !/^\d{4,8}$/.test(hsn)) return setFormError('The HSN code is 4 to 8 digits.')
    const fruitsPerBox = optionalWhole(f.fruitsPerBox, 1, 200)
    if (fruitsPerBox === undefined) return setFormError('Mangoes per box is a whole number from 1 to 200, or leave it empty.')
    const fruitWeightG = optionalWhole(f.fruitWeightG, 50, 3000)
    if (fruitWeightG === undefined) return setFormError('The weight of one mango is in grams, from 50 to 3000, or leave it empty.')
    const input: SaveInput = {
      sku,
      name: f.name.trim(),
      variety: f.variety.trim(),
      boxSize: f.boxSize.trim(),
      price: Math.round(price * 100),
      description: f.description.trim(),
      sortOrder: Math.max(0, Math.round(Number(f.sortOrder) || 0)),
      gstRate: Math.round(gst * 100) / 10_000,
      hsnCode: hsn || null,
      fruitsPerBox,
      fruitWeightG,
    }
    if (product?.price != null && input.price !== product.price) return setConfirmPrice(input)
    save.mutate(input)
  }

  if (product && confirmPrice) {
    return (
      <Dialog
        title={`Change the price of ${product.name}?`}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmPrice(null)} data-autofocus>
              Back
            </button>
            <button type="submit" form="price-form" className="btn btn-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Change price'}
            </button>
          </>
        }
      >
        <form
          id="price-form"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ ...confirmPrice, reason: reason.trim() || undefined })
          }}
          noValidate
        >
          <p className="price-change">
            <span aria-hidden="true">
              {rupees(product.price!)} → <strong>{rupees(confirmPrice.price)}</strong>
            </span>
            <span className="sr-only">
              From {rupees(product.price!)} to {rupees(confirmPrice.price)}
            </span>
          </p>
          <p>The new price applies from the next checkout. Orders already placed keep their price.</p>
          <div className="field">
            <label htmlFor="price-reason">Reason (optional)</label>
            <textarea id="price-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="price-reason-hint" />
            <p className="hint" id="price-reason-hint">
              Kept in the staff activity with the old price, like "Mandi rate went up".
            </p>
          </div>
          <FormError error={save.error} />
        </form>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={product ? `Edit ${product.name}` : 'Add product'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="product-form" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : product ? 'Save' : 'Add product'}
          </button>
        </>
      }
    >
      <form id="product-form" onSubmit={onSubmit} noValidate>
        {!product && (
          <div className="field">
            <label htmlFor="product-sku">SKU</label>
            <input id="product-sku" autoComplete="off" maxLength={20} value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value.toUpperCase() })} />
            <p className="hint">A short code that never changes, like KES-3. Letters, digits and dashes.</p>
          </div>
        )}
        <div className="field">
          <label htmlFor="product-name">Name</label>
          <input id="product-name" maxLength={80} value={f.name} onChange={set('name')} />
          <p className="hint">What customers see, like "Kesar 3kg Box".</p>
        </div>
        <div className="field">
          <label htmlFor="product-variety">Variety</label>
          <input id="product-variety" list="product-varieties" maxLength={40} value={f.variety} onChange={set('variety')} />
          <datalist id="product-varieties">
            {varieties.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <p className="hint">Batches are received by variety. It can't change once a batch holds this product.</p>
        </div>
        <div className="field">
          <label htmlFor="product-box">Box size</label>
          <input id="product-box" maxLength={20} value={f.boxSize} onChange={set('boxSize')} />
        </div>
        <div className="field">
          <label htmlFor="product-price">Price in rupees, GST included</label>
          <input id="product-price" inputMode="decimal" value={f.price} onChange={set('price')} />
        </div>
        <fieldset className="field">
          <legend>What is in the box (optional)</legend>
          <div className="field">
            <label htmlFor="product-fruits">Mangoes per box, about</label>
            <input id="product-fruits" inputMode="numeric" value={f.fruitsPerBox} onChange={set('fruitsPerBox')} />
          </div>
          <div className="field">
            <label htmlFor="product-weight">Weight of one mango, about, in grams</label>
            <input id="product-weight" inputMode="numeric" value={f.fruitWeightG} onChange={set('fruitWeightG')} aria-describedby="product-contents-hint" />
            <p className="hint" id="product-contents-hint">
              Shown on the product page, like "About 12 mangoes, around 250 g each". Leave both empty to show nothing.
            </p>
          </div>
        </fieldset>
        <div className="field">
          <span className="field-label" id="product-photo-label">
            Photo (optional)
          </span>
          <div className="photo-pick">
            {preview || current ? (
              <img src={preview ?? current!} alt={`Photo of ${f.name || 'this product'}`} className="product-photo-preview" />
            ) : (
              <span className="product-photo-preview product-photo-empty small muted">No photo</span>
            )}
            <div>
              <label htmlFor="product-photo" className="btn btn-small">
                {preview || current ? 'Change photo' : 'Choose photo'}
              </label>
              <input
                id="product-photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-describedby="product-photo-label product-photo-hint"
                onChange={(e) => void pickPhoto(e.target.files?.[0])}
              />{' '}
              {(preview || current) && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setPhoto(null)
                    setDropPhoto(Boolean(product?.photoUrl))
                  }}
                >
                  Remove photo
                </button>
              )}
              <p className="hint" id="product-photo-hint">
                Shown on the product's tile and page in the shop. A square photo of the fruit or the box works best.
              </p>
            </div>
          </div>
          <FormError error={photoError} />
        </div>
        <div className="field">
          <label htmlFor="product-description">Description (optional)</label>
          <textarea id="product-description" rows={2} maxLength={300} value={f.description} onChange={set('description')} />
          <p className="hint">One or two lines for the product card in the shop.</p>
        </div>
        <div className="field">
          <label htmlFor="product-order">Position in the shop</label>
          <input id="product-order" inputMode="numeric" value={f.sortOrder} onChange={set('sortOrder')} />
          <p className="hint">Lower numbers show first. Products with the same number are listed by name.</p>
        </div>
        <details className="field">
          <summary>Tax details</summary>
          <div className="field">
            <label htmlFor="product-gst">GST percent</label>
            <input id="product-gst" inputMode="decimal" value={f.gst} onChange={set('gst')} />
            <p className="hint">Fresh mangoes have nil GST.</p>
          </div>
          <div className="field">
            <label htmlFor="product-hsn">HSN code</label>
            <input id="product-hsn" inputMode="numeric" maxLength={8} value={f.hsnCode} onChange={set('hsnCode')} />
          </div>
        </details>
        <FormError error={formError ?? save.error} />
      </form>
    </Dialog>
  )
}

/** A temporary URL for a picked file, released when it changes. */
function useObjectUrl(blob: Blob | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) return setUrl(null)
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

function ProductThumb({ product: p }: { product: Product }) {
  if (!p.photoUrl) return <span className="product-thumb product-photo-empty" aria-hidden="true" />
  return <img src={`${API_URL}${p.photoUrl}`} alt="" className="product-thumb" loading="lazy" />
}
