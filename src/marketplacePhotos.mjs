import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export const PHOTO_BUCKET = 'marketplace-images'
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
const TTL = 2 * 60 * 60 * 1000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const PATH = /^managed\/([a-f0-9-]{36})\/(\d{13})-([a-f0-9-]{36})\.jpg$/i
export class PhotoError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// Receipts survive server restarts and bind a unique, non-overwritable object to
// the authenticated seller, target listing and expected byte count.
export function createMarketplacePhotos({ supabase, secret, now = Date.now }) {
  const bucket = supabase.storage.from(PHOTO_BUCKET)
  const publicUrl = (path) => bucket.getPublicUrl(path).data.publicUrl
  const sign = (payload) => createHmac('sha256', secret).update(`marketplace-photo-v1:${payload}`).digest('base64url')
  function requireConfig() {
    if (typeof secret !== 'string' || secret.length < 32) throw new PhotoError('Photo uploads are not configured on the server.', 503)
  }
  function readReceipt(receipt, userId, listingId) {
    requireConfig()
    if (typeof receipt !== 'string' || receipt.length > 2048) throw new PhotoError('Choose the photo again and retry.')
    const [payload, signature, extra] = receipt.split('.')
    const expected = Buffer.from(sign(payload || ''))
    const actual = Buffer.from(signature || '')
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new PhotoError('Invalid photo authorization.')
    let data
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new PhotoError('Invalid photo authorization.') }
    if (data.userId !== userId || data.listingId !== (listingId || null) || !PATH.test(data.path || '') || !data.path.startsWith(`managed/${userId}/`)) throw new PhotoError('This photo belongs to another seller or listing.', 403)
    if (!Number.isFinite(data.expiresAt) || now() >= data.expiresAt) throw new PhotoError('Photo authorization expired. Choose the photo again and retry.')
    return data
  }
  function isBucketUrl(value) {
    try {
      const url = new URL(value), base = new URL(publicUrl(''))
      return url.hostname === base.hostname && decodeURIComponent(url.pathname).startsWith(decodeURIComponent(base.pathname))
    } catch { return false }
  }
  return {
    publicUrl,
    async authorize(user, input = {}) {
      requireConfig()
      if (!user?.purdue_linked_at || !UUID.test(user.id)) throw new PhotoError('Link your Purdue account before uploading photos.', 403)
      if (input.contentType !== 'image/jpeg' || !Number.isInteger(input.byteSize) || input.byteSize < 4 || input.byteSize > PHOTO_MAX_BYTES) throw new PhotoError('Choose a JPEG photo no larger than 5 MB.')
      if (input.listingId != null && !UUID.test(input.listingId)) throw new PhotoError('Invalid listing.')
      // Bucket restrictions protect the direct upload before the attach-time check.
      const { data: settings, error: settingsError } = await supabase.storage.getBucket(PHOTO_BUCKET)
      if (settingsError || !settings?.public || !settings.file_size_limit || settings.file_size_limit > PHOTO_MAX_BYTES || !settings.allowed_mime_types?.includes('image/jpeg') || settings.allowed_mime_types.some((type) => !['image/jpeg', 'image/png', 'image/webp'].includes(type))) throw new PhotoError('Photo storage settings need attention. Please try again later.', 503)
      const issuedAt = now()
      const path = `managed/${user.id}/${issuedAt}-${randomUUID()}.jpg`
      const { data, error } = await bucket.createSignedUploadUrl(path, { upsert: false })
      if (error || !data?.token) throw new PhotoError('Could not start the photo upload. Please retry.', 503)
      const details = { path, userId: user.id, listingId: input.listingId || null, byteSize: input.byteSize, expiresAt: issuedAt + TTL }
      const payload = Buffer.from(JSON.stringify(details)).toString('base64url')
      return { bucket: PHOTO_BUCKET, path, token: data.token, receipt: `${payload}.${sign(payload)}`, expiresAt: details.expiresAt }
    },
    async resolve(body, userId, listingId = null, existingUrl = null, existingImages = []) {
      const retained = existingImages.length ? existingImages : existingUrl ? [existingUrl] : []
      if (body.photos !== undefined) {
        if (body.imageUrl !== undefined || body.imageUploadReceipt !== undefined) throw new PhotoError('Choose one photo format.')
        if (!Array.isArray(body.photos) || body.photos.length > 6) throw new PhotoError('Choose up to 6 photos.')
        const urls = []
        for (const photo of body.photos) {
          if (!photo || typeof photo !== 'object' || Array.isArray(photo) || (typeof photo.url === 'string') === (typeof photo.receipt === 'string')) throw new PhotoError('Each photo needs one image link or upload receipt.')
          if (photo.receipt !== undefined) {
            const resolved = await this.resolve({ imageUploadReceipt: photo.receipt }, userId, listingId)
            urls.push(resolved.image_url)
          } else {
            let url
            try { url = new URL(photo.url) } catch { throw new PhotoError('Image URL must be a valid http(s) link') }
            if (!['http:', 'https:'].includes(url.protocol)) throw new PhotoError('Image URL must be a valid http(s) link')
            const value = photo.url.trim()
            if (isBucketUrl(value) && !retained.includes(value)) throw new PhotoError('Select the photo to upload it to this listing.')
            urls.push(value)
          }
        }
        if (new Set(urls).size !== urls.length) throw new PhotoError('Choose each photo only once.')
        return { image_url: urls[0] || null, image_urls: urls }
      }
      if (body.imageUploadReceipt !== undefined) {
        if (body.imageUrl) throw new PhotoError('Choose either an uploaded photo or an image link.')
        const data = readReceipt(body.imageUploadReceipt, userId, listingId)
        const { data: info, error: infoError } = await bucket.info(data.path)
        if (infoError || info?.contentType !== 'image/jpeg' || Number(info?.size) !== data.byteSize || data.byteSize > PHOTO_MAX_BYTES) throw new PhotoError('The uploaded photo is missing or incomplete. Choose it again and retry.')
        const { data: file, error } = await bucket.download(data.path)
        if (error || !file || file.size !== data.byteSize) throw new PhotoError('Could not verify the uploaded photo. Please retry.')
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw new PhotoError('The uploaded file is not a JPEG photo.')
        return { image_url: publicUrl(data.path), image_urls: [publicUrl(data.path)] }
      }
      const legacyUrl = String(body.imageUrl ?? '').trim()
      if (legacyUrl && legacyUrl !== existingUrl && isBucketUrl(legacyUrl)) throw new PhotoError('Select the photo to upload it to this listing.')
      if (body.imageUrl !== undefined && (legacyUrl || null) !== existingUrl) return { image_urls: legacyUrl ? [legacyUrl] : [] }
      return {}
    },
  }
}

export function photoAuthorizationHandler({ photos, findOwnedListing }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    try {
      const input = req.body || {}
      if (input.listingId && !await findOwnedListing(input.listingId, req.currentUser.id)) throw new PhotoError('Listing not found or not yours.', 404)
      return res.status(201).json({ upload: await photos.authorize(req.currentUser, input) })
    } catch (error) { return respondPhotoError(res, error) }
  }
}
export function respondPhotoError(res, error) {
  const status = error instanceof PhotoError ? error.status : 503
  return res.status(status).json({ error: { message: error instanceof PhotoError ? error.message : 'Photo storage is unavailable. Please retry.', status } })
}

// Only newly managed objects older than a day are candidates. Receipts expire
// after two hours, so cleanup cannot race a new attachment. Soft-deleted listing
// references are retained for admin restore; purging the row releases the photo.
export async function cleanupMarketplacePhotos(supabase, { now = Date.now(), dryRun = true } = {}) {
  const bucket = supabase.storage.from(PHOTO_BUCKET)
  const result = { candidates: 0, removed: 0 }
  async function listAll(prefix) {
    const rows = []
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await bucket.list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
      if (error) throw error
      rows.push(...data)
      if (data.length < 100) return rows
    }
  }
  for (const folder of await listAll('managed')) {
    if (folder.id || !UUID.test(folder.name)) continue
    // Collect first: deleting while paginating would skip objects.
    for (const object of await listAll(`managed/${folder.name}`)) {
      const path = `managed/${folder.name}/${object.name}`, match = PATH.exec(path)
      if (!object.id || !match || Number(match[2]) > now - 24 * 60 * 60 * 1000) continue
      const url = bucket.getPublicUrl(path).data.publicUrl
      const { data, error } = await supabase.from('marketplace_listings').select('id').eq('image_url', url).limit(1)
      if (error) throw error
      if (data.length) continue
      const { data: gallery, error: galleryError } = await supabase.from('marketplace_listings').select('id').contains('image_urls', [url]).limit(1)
      if (galleryError) throw galleryError
      if (gallery.length) continue
      result.candidates++
      if (!dryRun) {
        const { error: removeError } = await bucket.remove([path])
        if (removeError) throw removeError
        result.removed++
      }
    }
  }
  return result
}
