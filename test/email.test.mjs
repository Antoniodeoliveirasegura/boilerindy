// CAN-SPAM guardrail tests (issue #116). The commercial footer must refuse to
// render without the legally required physical address + unsubscribe link, so a
// non-compliant marketing email can't be built. The transactional reset email is
// checked for an honest subject (its only CAN-SPAM obligation).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { commercialEmailFooter, advertiserPasswordResetEmail } from '../src/email.mjs'

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
