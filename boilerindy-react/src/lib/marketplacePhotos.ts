// Listing photo uploads on the website (issue #171). Same flow as the mobile
// app and the contract in docs/marketplace-photos.md:
//
//   1. re-encode whatever the student picked to a JPEG no larger than 1600 px
//      on its long edge and 5 MiB (also turns PNG / WebP / HEIC-where-decodable
//      into the JPEG the server insists on, and drops camera trailers the
//      server's end-of-image check would reject);
//   2. POST /api/marketplace/photos/authorize for a signed upload plus a
//      receipt bound to the seller, the listing being edited (if any), the
//      object path and the byte size;
//   3. PUT the bytes straight to Supabase Storage with the browser client;
//   4. hand the receipt to the listing create / edit call as imageUploadReceipt
//      instead of an imageUrl. The server re-checks size, type and markers.
//
// The receipt lasts two hours and can be reused for a save retry; the page
// keeps the prepared JPEG so an expired receipt is refreshed without asking the
// student to pick the photo again.

import { authRequest } from './authApi'
import { supabase } from './supabase'

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
export const PHOTO_MAX_EDGE = 1600
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/*'
// Stop reusing a receipt a little before the server's two-hour expiry so a
// save that starts near the deadline does not fail on arrival.
export const RECEIPT_REUSE_MARGIN_MS = 5 * 60 * 1000

const QUALITY_STEPS = [0.86, 0.74, 0.62, 0.5]
const EDGE_STEPS = [PHOTO_MAX_EDGE, 1280, 1024]

export type PhotoUpload = { bucket: string; path: string; token: string; receipt: string; expiresAt: number }
export type PhotoStep = 'preparing' | 'authorizing' | 'uploading'
export type ReadyPhoto = {
  receipt: string
  expiresAt: number
  byteSize: number
  path: string
  /** Object URL of the prepared JPEG; the owner revokes it when done. */
  previewUrl: string
  /** The prepared JPEG, kept so an expired receipt can be refreshed. */
  blob: Blob
}
export type PipelineOptions = { listingId?: string | null; onStep?: (step: PhotoStep) => void }

export class PhotoUploadError extends Error {
  status?: number
  /** False when trying the same bytes again cannot help (bad file, not linked). */
  retryable: boolean
  constructor(message: string, { status, retryable = true }: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'PhotoUploadError'
    this.status = status
    this.retryable = retryable
  }
}

/** Scale (width, height) to fit inside maxEdge without ever upscaling. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height)
  if (!(longest > 0)) return { width: 1, height: 1, scale: 1 }
  const scale = Math.min(1, maxEdge / longest)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/** The server checks the same two markers before attaching a photo. */
export function isJpegBytes(bytes: Uint8Array): boolean {
  const n = bytes.length
  return n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9
}

export function isReceiptUsable(photo: Pick<ReadyPhoto, 'expiresAt'> | null | undefined, now: number = Date.now()): boolean {
  if (!photo) return false
  return Number.isFinite(photo.expiresAt) && now < photo.expiresAt - RECEIPT_REUSE_MARGIN_MS
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Body for POST /api/marketplace/photos/authorize; listingId only on edits. */
export function authorizeBody(byteSize: number, listingId?: string | null): { contentType: 'image/jpeg'; byteSize: number; listingId?: string } {
  return listingId ? { contentType: 'image/jpeg', byteSize, listingId } : { contentType: 'image/jpeg', byteSize }
}

/** Turn whatever authRequest or Storage threw into a PhotoUploadError with a usable message. */
export function toPhotoError(error: unknown, fallback = 'Could not upload the photo. Please retry.'): PhotoUploadError {
  if (error instanceof PhotoUploadError) return error
  const status = typeof (error as { status?: unknown })?.status === 'number' ? ((error as { status: number }).status as number) : undefined
  const raw = error instanceof Error ? error.message : ''
  const message = raw && raw !== 'Request failed' ? raw : fallback
  // 4xx answers describe something about the request (not linked, bad file,
  // wrong listing) that the same bytes cannot fix; 429 and 5xx are worth a retry.
  const retryable = status === undefined || status === 429 || status >= 500
  return new PhotoUploadError(message, { status, retryable })
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void }

async function decodeImage(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image applies the EXIF orientation, so a portrait phone photo is
      // not uploaded lying on its side.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('decode'))
      el.src = url
    })
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch {
    URL.revokeObjectURL(url)
    throw new PhotoUploadError('Could not read that image. Try a JPEG or PNG photo.', { retryable: false })
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PhotoUploadError('Could not convert the photo.', { retryable: false }))),
      'image/jpeg',
      quality,
    )
  })
}

/** Re-encode any picked image to a JPEG inside the server's limits. */
export async function prepareListingPhoto(file: Blob): Promise<Blob> {
  const decoded = await decodeImage(file)
  try {
    for (const edge of EDGE_STEPS) {
      const { width, height } = fitWithin(decoded.width, decoded.height, edge)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new PhotoUploadError('Could not convert the photo.', { retryable: false })
      // Transparent PNG areas become white, not black, once they are JPEG.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(decoded.source, 0, 0, width, height)
      for (const quality of QUALITY_STEPS) {
        const blob = await canvasToJpeg(canvas, quality)
        if (blob.size <= PHOTO_MAX_BYTES) return blob
      }
    }
    throw new PhotoUploadError('That photo is too large even after resizing. Try a smaller one.', { retryable: false })
  } finally {
    decoded.close()
  }
}

export async function authorizePhotoUpload(byteSize: number, listingId?: string | null): Promise<PhotoUpload> {
  let data: { upload?: PhotoUpload } | null = null
  try {
    data = (await authRequest('/api/marketplace/photos/authorize', {
      method: 'POST',
      body: JSON.stringify(authorizeBody(byteSize, listingId)),
    })) as { upload?: PhotoUpload }
  } catch (error) {
    throw toPhotoError(error, 'Could not start the photo upload. Please retry.')
  }
  if (!data?.upload?.token || !data.upload.receipt || !data.upload.path) {
    throw new PhotoUploadError('Could not start the photo upload. Please retry.')
  }
  return data.upload
}

export async function uploadPhotoBytes(upload: PhotoUpload, jpeg: Blob): Promise<void> {
  const { error } = await supabase.storage
    .from(upload.bucket)
    .uploadToSignedUrl(upload.path, upload.token, jpeg, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new PhotoUploadError('The photo upload did not finish. Check your connection and retry.')
}

async function uploadPrepared(jpeg: Blob, previewUrl: string, { listingId, onStep }: PipelineOptions): Promise<ReadyPhoto> {
  onStep?.('authorizing')
  const upload = await authorizePhotoUpload(jpeg.size, listingId)
  onStep?.('uploading')
  await uploadPhotoBytes(upload, jpeg)
  return { receipt: upload.receipt, expiresAt: upload.expiresAt, byteSize: jpeg.size, path: upload.path, previewUrl, blob: jpeg }
}

/** The whole pipeline for a freshly picked file. */
export async function uploadListingPhoto(file: Blob, options: PipelineOptions = {}): Promise<ReadyPhoto> {
  options.onStep?.('preparing')
  const jpeg = await prepareListingPhoto(file)
  if (!isJpegBytes(new Uint8Array(await jpeg.arrayBuffer()))) {
    throw new PhotoUploadError('Could not convert the photo.', { retryable: false })
  }
  const previewUrl = URL.createObjectURL(jpeg)
  try {
    return await uploadPrepared(jpeg, previewUrl, options)
  } catch (error) {
    URL.revokeObjectURL(previewUrl)
    throw error
  }
}

/** Fresh receipt for an already prepared photo (expired receipt, or a retry). */
export async function reuploadListingPhoto(photo: ReadyPhoto, options: PipelineOptions = {}): Promise<ReadyPhoto> {
  return uploadPrepared(photo.blob, photo.previewUrl, options)
}
