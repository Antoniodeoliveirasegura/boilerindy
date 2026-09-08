// Explicit, small live Storage smoke test. Never creates a user or listing.
// Credentials are read from the backend environment, never printed.
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { createMarketplacePhotos, PHOTO_BUCKET } from '../src/marketplacePhotos.mjs'

if (!process.argv.includes('--live') || !process.argv[2] || process.argv[2].startsWith('--')) {
  console.error('Usage: node scripts/test-marketplace-photo-storage.mjs /path/to/small-test.jpg --live')
  process.exit(1)
}
const bytes = readFileSync(process.argv[2])
if (bytes.length > 100000) throw new Error('Use a test JPEG smaller than 100 KB.')
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const photos = createMarketplacePhotos({ supabase: client, secret: process.env.SESSION_SECRET || process.env.BETTER_AUTH_SECRET })
const user = { id: randomUUID(), purdue_linked_at: new Date().toISOString() }
let path
try {
  const upload = await photos.authorize(user, { contentType: 'image/jpeg', byteSize: bytes.length })
  path = upload.path
  // Upload using only the signed token, with no server key or session headers.
  const destination = new URL(`/storage/v1/object/upload/sign/${PHOTO_BUCKET}/${path}`, process.env.SUPABASE_URL)
  destination.searchParams.set('token', upload.token)
  if (process.env.SUPABASE_SMOKE_PUBLIC_KEY) {
    const mobile = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SMOKE_PUBLIC_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await mobile.storage.from(PHOTO_BUCKET).uploadToSignedUrl(path, upload.token, bytes, { contentType: 'image/jpeg' })
    if (error) throw new Error('Public-client signed upload failed')
  } else {
    const sent = await fetch(destination, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes })
    if (!sent.ok) throw new Error(`Signed upload failed (${sent.status})`)
  }
  const overwrite = await fetch(destination, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: bytes })
  if (overwrite.ok) throw new Error('Storage unexpectedly allowed an overwrite')
  const resolved = await photos.resolve({ imageUploadReceipt: upload.receipt }, user.id)
  const response = await fetch(resolved.image_url)
  if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes)) throw new Error('Public read failed')
  console.log('PASS: signed upload, server verification, and public JPEG read match.')
} catch (error) {
  console.error('Storage smoke test failed:', error.message)
  process.exitCode = 1
} finally {
  if (path) {
    const { error } = await client.storage.from(PHOTO_BUCKET).remove([path])
    if (error) { console.error('Test photo cleanup failed; rerun cleanup for the test object.'); process.exitCode = 1 }
    else console.log('PASS: test object removed from Storage.')
  }
}
