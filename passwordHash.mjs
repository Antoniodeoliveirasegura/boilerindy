import crypto from 'node:crypto'

// Shared scrypt password hashing, extracted from server.mjs so the advertiser
// portal and seed script reuse the exact same scheme as student auth.
// Stored format is `<saltHex>:<scryptHex>` (16-byte salt, 64-byte derived key).

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || '').split(':')
  if (!salt || !expectedHash) return false
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))
}
