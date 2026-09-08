import { describe, expect, test, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: { storage: { from: () => ({}) } } }))

import {
  PHOTO_MAX_BYTES,
  PhotoUploadError,
  RECEIPT_REUSE_MARGIN_MS,
  authorizeBody,
  fitWithin,
  formatBytes,
  isJpegBytes,
  isReceiptUsable,
  toPhotoError,
} from './marketplacePhotos'

// Issue #171 - the pure parts of the website's photo pipeline. The canvas and
// network parts are exercised end to end in e2e/marketplace.spec.js.

describe('fitWithin', () => {
  test('shrinks the long edge to the limit and never upscales', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200, scale: 0.4 })
    expect(fitWithin(1200, 3200, 1600)).toEqual({ width: 600, height: 1600, scale: 0.5 })
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600, scale: 1 })
    expect(fitWithin(0, 0, 1600)).toEqual({ width: 1, height: 1, scale: 1 })
  })
})

describe('isJpegBytes', () => {
  test('wants the start and end markers the server checks', () => {
    expect(isJpegBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]))).toBe(true)
    expect(isJpegBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd9]))).toBe(false)
    expect(isJpegBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]))).toBe(false)
    expect(isJpegBytes(new Uint8Array([0xff, 0xd8]))).toBe(false)
  })
})

describe('isReceiptUsable', () => {
  test('stops a few minutes before the expiry', () => {
    const now = 1_000_000_000
    expect(isReceiptUsable({ expiresAt: now + RECEIPT_REUSE_MARGIN_MS + 1 }, now)).toBe(true)
    expect(isReceiptUsable({ expiresAt: now + RECEIPT_REUSE_MARGIN_MS - 1 }, now)).toBe(false)
    expect(isReceiptUsable({ expiresAt: Number.NaN }, now)).toBe(false)
    expect(isReceiptUsable(null, now)).toBe(false)
  })
})

describe('formatBytes and authorizeBody', () => {
  test('formats sizes and only sends listingId on edits', () => {
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(312 * 1024)).toBe('312 KB')
    expect(formatBytes(PHOTO_MAX_BYTES)).toBe('5.0 MB')
    expect(authorizeBody(1234)).toEqual({ contentType: 'image/jpeg', byteSize: 1234 })
    expect(authorizeBody(1234, 'listing-2')).toEqual({ contentType: 'image/jpeg', byteSize: 1234, listingId: 'listing-2' })
    expect(authorizeBody(1234, null)).toEqual({ contentType: 'image/jpeg', byteSize: 1234 })
  })
})

describe('toPhotoError', () => {
  test('keeps server messages and decides retryability by status', () => {
    const linked = Object.assign(new Error('Link your Purdue account before uploading photos.'), { status: 403 })
    const e1 = toPhotoError(linked)
    expect(e1).toBeInstanceOf(PhotoUploadError)
    expect(e1.message).toBe('Link your Purdue account before uploading photos.')
    expect(e1.retryable).toBe(false)

    const down = Object.assign(new Error('Photo storage settings need attention. Please try again later.'), { status: 503 })
    expect(toPhotoError(down).retryable).toBe(true)
    expect(toPhotoError(Object.assign(new Error('Too many photo uploads.'), { status: 429 })).retryable).toBe(true)

    const generic = toPhotoError(new Error('Request failed'), 'fallback text')
    expect(generic.message).toBe('fallback text')
    expect(generic.retryable).toBe(true)

    const own = new PhotoUploadError('nope', { retryable: false })
    expect(toPhotoError(own)).toBe(own)
  })
})
