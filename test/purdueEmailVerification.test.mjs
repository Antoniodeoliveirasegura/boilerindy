import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  PURDUE_EMAIL_DOMAIN,
  RESEND_COOLDOWN_MS,
  attemptsLeft,
  challengeExpiry,
  cooldownRemainingSeconds,
  evaluateChallenge,
  generateCode,
  hashCode,
  isChallengeExpired,
  normalizePurdueEmail,
  parseVerificationCode,
} from '../src/purdueEmailVerification.mjs'

// Issue #181: the rules behind Purdue email-code verification, without the
// database or an email provider.

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0)
const iso = (ms) => new Date(ms).toISOString()

function challenge(overrides = {}) {
  const id = overrides.id ?? '11111111-1111-4111-8111-111111111111'
  return {
    id,
    code_hash: hashCode(id, '123456'),
    expires_at: iso(NOW + CODE_TTL_MS),
    attempts: 0,
    consumed_at: null,
    ...overrides,
  }
}

test('the limits the routes and the docs promise', () => {
  assert.equal(PURDUE_EMAIL_DOMAIN, 'purdue.edu')
  assert.equal(CODE_TTL_MS, 10 * 60 * 1000)
  assert.equal(MAX_ATTEMPTS, 5)
  assert.equal(RESEND_COOLDOWN_MS, 60 * 1000)
})

test('normalizePurdueEmail keeps an exact @purdue.edu address, lowercased and trimmed', () => {
  assert.equal(normalizePurdueEmail('  JDoe@Purdue.EDU '), 'jdoe@purdue.edu')
  assert.equal(normalizePurdueEmail('first.last_2-x@purdue.edu'), 'first.last_2-x@purdue.edu')
  assert.equal(normalizePurdueEmail(`${'a'.repeat(64)}@purdue.edu`), `${'a'.repeat(64)}@purdue.edu`)
})

test('normalizePurdueEmail refuses subdomains, lookalikes, plus tags and junk', () => {
  for (const value of [
    'jdoe@cs.purdue.edu',
    'jdoe@purdue.edu.evil.com',
    'jdoe@notpurdue.edu',
    'jdoe@purdue.com',
    'jdoe@purdue.edu.',
    'jdoe+alt@purdue.edu',
    'jdoe@@purdue.edu',
    'j@doe@purdue.edu',
    '@purdue.edu',
    'jdoe',
    'jd oe@purdue.edu',
    `${'a'.repeat(65)}@purdue.edu`,
    '',
    null,
    undefined,
    42,
    { email: 'jdoe@purdue.edu' },
  ]) {
    assert.equal(normalizePurdueEmail(value), null, String(value))
  }
})

test('parseVerificationCode takes six digits, spaced or not, and nothing else', () => {
  assert.equal(parseVerificationCode('123456'), '123456')
  assert.equal(parseVerificationCode(' 123 456 '), '123456')
  assert.equal(parseVerificationCode('000042'), '000042')
  assert.equal(parseVerificationCode(654321), '654321')
  for (const value of ['12345', '1234567', '12a456', '', null, undefined, 42, ['123456'], { code: '123456' }]) {
    assert.equal(parseVerificationCode(value), null, JSON.stringify(value))
  }
})

test('generateCode gives six digits, leading zeros kept', () => {
  for (let i = 0; i < 200; i += 1) assert.match(generateCode(), /^\d{6}$/)
})

test('hashCode is sha256 of the challenge id and the code, so a hash only fits its own challenge', () => {
  const hash = hashCode('c1', '123456')
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash, hashCode('c1', '123456'))
  assert.notEqual(hash, hashCode('c2', '123456'))
  assert.notEqual(hash, hashCode('c1', '123457'))
})

test('challengeExpiry is ten minutes on, and isChallengeExpired reads it', () => {
  assert.equal(challengeExpiry(NOW), iso(NOW + CODE_TTL_MS))
  assert.equal(isChallengeExpired(iso(NOW + 1), NOW), false)
  assert.equal(isChallengeExpired(iso(NOW), NOW), true)
  assert.equal(isChallengeExpired('not a date', NOW), true)
  assert.equal(isChallengeExpired(null, NOW), true)
})

test('cooldownRemainingSeconds counts down a minute from the newest code, and never past it', () => {
  assert.equal(cooldownRemainingSeconds(null, NOW), 0)
  assert.equal(cooldownRemainingSeconds('garbage', NOW), 0)
  assert.equal(cooldownRemainingSeconds(iso(NOW), NOW), 60)
  assert.equal(cooldownRemainingSeconds(iso(NOW - 1), NOW), 60)
  assert.equal(cooldownRemainingSeconds(iso(NOW - 59_001), NOW), 1)
  assert.equal(cooldownRemainingSeconds(iso(NOW - 60_000), NOW), 0)
  assert.equal(cooldownRemainingSeconds(iso(NOW - 3_600_000), NOW), 0)
  // A clock ahead of the server's still waits one minute at most.
  assert.equal(cooldownRemainingSeconds(iso(NOW + 3_600_000), NOW), 60)
})

test('attemptsLeft counts down from MAX_ATTEMPTS and stops at zero', () => {
  assert.equal(attemptsLeft({ attempts: 0 }), 5)
  assert.equal(attemptsLeft({ attempts: 4 }), 1)
  assert.equal(attemptsLeft({ attempts: 9 }), 0)
  assert.equal(attemptsLeft({}), 5)
})

test('evaluateChallenge answers ok for the right code on a live challenge', () => {
  assert.equal(evaluateChallenge(challenge(), '123456', NOW), 'ok')
  assert.equal(evaluateChallenge(challenge({ attempts: 4 }), '123456', NOW), 'ok')
})

test('evaluateChallenge answers wrong for any other code', () => {
  assert.equal(evaluateChallenge(challenge(), '123457', NOW), 'wrong')
  assert.equal(evaluateChallenge(challenge({ code_hash: 'not-hex' }), '123456', NOW), 'wrong')
  // The same code under another challenge's id does not match.
  assert.equal(evaluateChallenge(challenge({ code_hash: hashCode('other', '123456') }), '123456', NOW), 'wrong')
})

test('evaluateChallenge checks none, consumed, expired, exhausted, then the code', () => {
  assert.equal(evaluateChallenge(null, '123456', NOW), 'none')
  assert.equal(evaluateChallenge(undefined, '123456', NOW), 'none')
  // Consumed wins over everything after it, even with the right code.
  assert.equal(evaluateChallenge(challenge({ consumed_at: iso(NOW), expires_at: iso(NOW - 1), attempts: 5 }), '123456', NOW), 'consumed')
  // Expired wins over exhausted and over the right code.
  assert.equal(evaluateChallenge(challenge({ expires_at: iso(NOW), attempts: 5 }), '123456', NOW), 'expired')
  // Exhausted wins over the right code.
  assert.equal(evaluateChallenge(challenge({ attempts: 5 }), '123456', NOW), 'exhausted')
  assert.equal(evaluateChallenge(challenge({ attempts: 7 }), '000000', NOW), 'exhausted')
})
