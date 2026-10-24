import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { api } from './api'

// Queries shared between the home page, the product page and the route that prefetches the
// product page's data while its code loads, so they always use the same keys.

/**
 * How long a prefetched answer counts as fresh. Just long enough that the product page, mounting
 * once its code has loaded, reuses the prefetched answer instead of asking again.
 */
const PREFETCH_FRESH_MS = 10_000

/** What is on sale for a pincode and day (the home tiles and the product page's buy box). */
export const catalogueQuery = (pincode: string, date: string | null) =>
  queryOptions({ queryKey: ['catalogue', pincode, date], queryFn: () => api.catalogue(pincode, date), staleTime: PREFETCH_FRESH_MS })

/** Every box on sale with its price, before a pincode is known (home tiles and the product page). */
export const productsQuery = () => queryOptions({ queryKey: ['products'], queryFn: api.products, staleTime: 5 * 60_000 })

/** A product's reviews (of its whole variety) with the star summary, ten at a time. */
export const productReviewsQuery = (sku: string, stars: number | null = null, withPhotos = false) =>
  infiniteQueryOptions({
    queryKey: ['product-reviews', sku, stars, withPhotos],
    queryFn: ({ pageParam }) => api.productReviews(sku, { stars, withPhotos, cursor: pageParam, limit: 10 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: PREFETCH_FRESH_MS,
  })
