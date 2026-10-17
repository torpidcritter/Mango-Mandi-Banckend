// Delivery photos are shrunk on the phone before upload: a 12 MP camera shot
// becomes a ~150 KB JPEG, which uploads fast on a weak signal.

const MAX_SIDE = 1280

export async function shrinkPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That file is not a photo. Take the photo again.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
  if (!blob) throw new Error('Could not read the photo. Take it again.')
  return blob
}

/** Where the rider is, if the phone allows it within a few seconds. Never blocks a delivery. */
export function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000)
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer)
        resolve({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 })
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
      { enableHighAccuracy: true, timeout: 4000, maximumAge: 60_000 },
    )
  })
}
