// Claim photos are shrunk on the phone before upload: a 12 MP camera shot
// becomes a ~150 KB JPEG, which uploads fast on a weak signal.

const MAX_SIDE = 1280

export async function shrinkPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That file is not a photo. Choose a photo instead.')
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72))
  if (!blob) throw new Error('Could not read the photo. Try another one.')
  return blob
}
