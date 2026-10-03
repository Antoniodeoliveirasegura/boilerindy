import test from 'node:test'
import assert from 'node:assert/strict'
import { onboardingFlags } from '../src/onboardingFlags.mjs'

// Issue #372: with PURDUE_AUTH_MODE=off, needsPurdueConnection is always false,
// so it cannot say whether Purdue is linked. hasPurdueLinked is the only field
// that may, and the client's setup copy reads it.

const none = { linkedSourceCount: 0, classCount: 0 }

test('linking off, never linked: no Purdue prompt, schedule still needed, and not reported as linked', () => {
  assert.deepEqual(onboardingFlags({ counts: none, hasPurdueLinked: false, purdueLinkingEnabled: false }), {
    linkedSourceCount: 0,
    classCount: 0,
    hasPurdueLinked: false,
    needsPurdueConnection: false,
    needsScheduleSource: true,
  })
})

test('linking off, linked by emailed code: reported as linked', () => {
  const flags = onboardingFlags({ counts: none, hasPurdueLinked: true, purdueLinkingEnabled: false })
  assert.equal(flags.hasPurdueLinked, true)
  assert.equal(flags.needsPurdueConnection, false)
  assert.equal(flags.needsScheduleSource, true)
})

test('linking on, not linked: asks for Purdue first, not a schedule source', () => {
  const flags = onboardingFlags({ counts: none, hasPurdueLinked: false, purdueLinkingEnabled: true })
  assert.equal(flags.needsPurdueConnection, true)
  assert.equal(flags.needsScheduleSource, false)
})

test('linking on, linked with a source: nothing left to set up', () => {
  const flags = onboardingFlags({ counts: { linkedSourceCount: 1, classCount: 4 }, hasPurdueLinked: true, purdueLinkingEnabled: true })
  assert.equal(flags.needsPurdueConnection, false)
  assert.equal(flags.needsScheduleSource, false)
  assert.equal(flags.classCount, 4)
})
