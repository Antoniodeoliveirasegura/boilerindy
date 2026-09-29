// CAN-SPAM guardrail tests (issue #116). The commercial footer must refuse to
// render without the legally required physical address + unsubscribe link, so a
// non-compliant marketing email can't be built. The transactional reset email is
// checked for an honest subject (its only CAN-SPAM obligation).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { commercialEmailFooter, advertiserPasswordResetEmail, purdueVerificationEmail } from '../src/email.mjs'

test('commercialEmailFooter throws without a postal address (CAN-SPAM)', () => {
  delete process.env.MAIL_POSTAL_ADDRESS
  assert.throws(
    () => commercialEmailFooter({ unsubscribeUrl: 'https://boilerindy.app/u/abc' }),
    /MAIL_POSTAL_ADDRESS/,
  )
})

test('commercialEmailFooter throws without an unsubscribe link (CAN-SPAM)', () => {
  process.env.MAIL_POSTAL_ADDRESS = '123 Test St, Indianapolis, IN 46202'
  assert.throws(() => commercialEmailFooter({}), /unsubscribeUrl/)
})

test('commercialEmailFooter includes the postal address and unsubscribe link', () => {
  process.env.MAIL_POSTAL_ADDRESS = '123 Test St, Indianapolis, IN 46202'
  const html = commercialEmailFooter({ unsubscribeUrl: 'https://boilerindy.app/u/abc' })
  assert.match(html, /123 Test St, Indianapolis, IN 46202/)
  assert.match(html, /https:\/\/boilerindy\.app\/u\/abc/)
  assert.match(html, /unsubscribe/i)
})

test('transactional reset email has an honest, non-deceptive subject', () => {
  const { subject } = advertiserPasswordResetEmail({ resetUrl: 'https://x', companyName: 'Acme' })
  assert.match(subject, /reset/i)
  assert.match(subject, /password/i)
})

// Issue #181: the verification code email is transactional too. Its subject
// says what it is, and the code is in the body exactly once, with no link.
test('Purdue verification email: honest subject, the code once, no link', () => {
  const { subject, html } = purdueVerificationEmail({ code: '042917' })
  assert.equal(subject, 'Your BoilerIndy verification code')
  assert.equal(html.split('042917').length - 1, 1)
  assert.doesNotMatch(subject, /042917/)
  assert.match(html, /It expires in 10 minutes\./)
  assert.match(html, /If you did not ask for this, ignore it; nothing changes on your account\./)
  assert.doesNotMatch(html, /<a\s|href=/i)
})
