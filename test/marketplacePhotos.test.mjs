import test from 'node:test'
import assert from 'node:assert/strict'
import { createMarketplacePhotos, PHOTO_MAX_BYTES, photoAuthorizationHandler, cleanupMarketplacePhotos } from '../src/marketplacePhotos.mjs'

const user = { id: '11111111-1111-4111-8111-111111111111', purdue_linked_at: '2026-09-09' }
const listingId = '22222222-2222-4222-8222-222222222222'
const jpeg = new Uint8Array([255, 216, 255, 224, 255, 217])
function fixture() {
  let time = 1788900000000
  const calls = []
  const bucket = {
    getPublicUrl: (path) => ({ data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/marketplace-images/${path}` } }),
    createSignedUploadUrl: async (path, options) => { calls.push({ path, options }); return { data: { token: 'storage-token' } } },
    info: async () => ({ data: { contentType: 'image/jpeg', size: jpeg.length } }),
    download: async () => ({ data: new Blob([jpeg]) }),
  }
  const supabase = { storage: { from: () => bucket, getBucket: async () => ({ data: { public: true, file_size_limit: PHOTO_MAX_BYTES, allowed_mime_types: ['image/jpeg'] } }) } }
  const photos = createMarketplacePhotos({ supabase, secret: 's'.repeat(32), now: () => time })
  return { photos, bucket, supabase, calls, advance: () => { time += 3 * 3600000 } }
}
const input = { contentType: 'image/jpeg', byteSize: jpeg.length }
test('authorizes immutable owner paths and resolves a complete JPEG to a shared URL', async () => {
  const { photos, calls } = fixture()
  const upload = await photos.authorize(user, input)
  assert.equal(upload.bucket, 'marketplace-images')
  assert.equal(calls[0].options.upsert, false)
  assert.ok(upload.path.startsWith(`managed/${user.id}/`))
  const resolved = await photos.resolve({ imageUploadReceipt: upload.receipt }, user.id)
  assert.equal(resolved.image_url, photos.publicUrl(upload.path))
  assert.deepEqual(await photos.resolve({ imageUrl: resolved.image_url }, user.id, listingId, resolved.image_url), {})
  await assert.rejects(photos.resolve({ imageUrl: resolved.image_url }, user.id), /Select the photo/)
})
test('rejects unlinked sellers, invalid sizes/types, insecure bucket settings and missing signing configuration', async () => {
  const { photos, supabase } = fixture()
  await assert.rejects(photos.authorize({ ...user, purdue_linked_at: null }, input), /Link your Purdue/)
  for (const value of [0, -1, PHOTO_MAX_BYTES + 1, 1.5, '6']) await assert.rejects(photos.authorize(user, { ...input, byteSize: value }), /JPEG/)
  await assert.rejects(photos.authorize(user, { ...input, contentType: 'image/heic' }), /JPEG/)
  supabase.storage.getBucket = async () => ({ data: { public: true, file_size_limit: null } })
  await assert.rejects(photos.authorize(user, input), /settings/)
  await assert.rejects(createMarketplacePhotos({ supabase }).authorize(user, input), /configured/)
})
test('binds receipts to seller and listing, rejects tampering and expiry before reading storage', async () => {
  const { photos, advance, bucket } = fixture()
  const upload = await photos.authorize(user, { ...input, listingId })
  bucket.info = () => { throw new Error('storage should not be read') }
  await assert.rejects(photos.resolve({ imageUploadReceipt: upload.receipt }, listingId, listingId), /another seller/)
  await assert.rejects(photos.resolve({ imageUploadReceipt: upload.receipt }, user.id), /another seller/)
  await assert.rejects(photos.resolve({ imageUploadReceipt: upload.receipt + 'x' }, user.id, listingId), /Invalid photo/)
  advance()
  await assert.rejects(photos.resolve({ imageUploadReceipt: upload.receipt }, user.id, listingId), /expired/)
})
test('rejects incomplete, spoofed and corrupt objects, and conflicting URL plus upload', async () => {
  const { photos, bucket } = fixture()
  const upload = await photos.authorize(user, input)
  const body = { imageUploadReceipt: upload.receipt }
  await assert.rejects(photos.resolve({ ...body, imageUrl: 'https://example.com/a.jpg' }, user.id), /either/)
  bucket.info = async () => ({ error: new Error('missing') })
  await assert.rejects(photos.resolve(body, user.id), /missing or incomplete/)
  bucket.info = async () => ({ data: { size: 6, contentType: 'text/html' } })
  await assert.rejects(photos.resolve(body, user.id), /missing or incomplete/)
  bucket.info = async () => ({ data: { size: 6, contentType: 'image/jpeg' } })
  bucket.download = async () => ({ data: new Blob(['abcdef']) })
  await assert.rejects(photos.resolve(body, user.id), /not a JPEG/)
  bucket.download = async () => ({ data: new Blob([jpeg.slice(0, 4)]) })
  await assert.rejects(photos.resolve(body, user.id), /verify/)
})
test('authorization handler verifies listing ownership and never returns storage secrets on failure', async () => {
  const { photos } = fixture()
  let status, response
  const res = { set: () => res, status: (s) => { status = s; return res }, json: (data) => { response = data; return res } }
  const req = { currentUser: user, body: { ...input, listingId } }
  await photoAuthorizationHandler({ photos, findOwnedListing: async () => null })(req, res)
  assert.equal(status, 404)
  await photoAuthorizationHandler({ photos, findOwnedListing: async () => { throw new Error('SECRET') } })(req, res)
  assert.equal(status, 503)
  assert.ok(!JSON.stringify(response).includes('SECRET'))
  await photoAuthorizationHandler({ photos, findOwnedListing: async () => ({ id: listingId }) })(req, res)
  assert.equal(status, 201)
  assert.ok(response.upload.receipt)
})
test('cleanup preserves referenced (including soft-deleted), recent and unmanaged objects; dry run never deletes', async () => {
  const { supabase, bucket } = fixture()
  const now = 1788900000000
  const name = (age, id = listingId) => `${now - age}-${id}.jpg`
  const old = name(2 * 86400000), referenced = name(3 * 86400000), recent = name(1000)
  const removed = []
  bucket.list = async (prefix) => ({ data: prefix === 'managed' ? [{ name: user.id, id: null }] : [old, referenced, recent, 'legacy.jpg'].map(name => ({ name, id: 'object' })) })
  bucket.remove = async (paths) => { removed.push(...paths); return {} }
  supabase.from = () => ({ select: () => ({ eq: (_, url) => ({ limit: async () => ({ data: url.endsWith(referenced) ? [{ id: 'retained' }] : [] }) }) }) })
  assert.deepEqual(await cleanupMarketplacePhotos(supabase, { now }), { candidates: 1, removed: 0 })
  assert.equal(removed.length, 0)
  assert.deepEqual(await cleanupMarketplacePhotos(supabase, { now, dryRun: false }), { candidates: 1, removed: 1 })
  assert.deepEqual(removed, [`managed/${user.id}/${old}`])
})
