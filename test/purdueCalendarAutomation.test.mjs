import test from 'node:test'
import assert from 'node:assert/strict'
import { isCalendarAutomationEnabled, startCalendarCapture } from '../src/purdueCalendarAutomation.mjs'

// The module imports playwright lazily inside the capture job, so importing it
// here never launches a browser; these tests only exercise the env flag.

const FLAG = 'PURDUE_CALENDAR_AUTOMATION'

/** Run fn with the flag set (unset for undefined), then restore the original value. */
async function withFlag(value, fn) {
  const previous = process.env[FLAG]
  if (value === undefined) delete process.env[FLAG]
  else process.env[FLAG] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[FLAG]
    else process.env[FLAG] = previous
  }
}

test('auto-capture is off when PURDUE_CALENDAR_AUTOMATION is unset', async () => {
  await withFlag(undefined, () => {
    assert.equal(isCalendarAutomationEnabled(), false)
  })
})

test('explicit off values keep auto-capture disabled', async () => {
  for (const value of ['0', 'false', 'off']) {
    await withFlag(value, () => {
      assert.equal(isCalendarAutomationEnabled(), false, `value=${value}`)
    })
  }
})

test('only 1 / true / on enable auto-capture', async () => {
  for (const value of ['1', 'true', 'on']) {
    await withFlag(value, () => {
      assert.equal(isCalendarAutomationEnabled(), true, `value=${value}`)
    })
  }
})

test('the on values are case-insensitive', async () => {
  for (const value of ['TRUE', 'On', 'ON']) {
    await withFlag(value, () => {
      assert.equal(isCalendarAutomationEnabled(), true, `value=${value}`)
    })
  }
})

test('unrecognised values do not enable auto-capture', async () => {
  for (const value of ['', 'yes', '2', 'enabled']) {
    await withFlag(value, () => {
      assert.equal(isCalendarAutomationEnabled(), false, `value=${JSON.stringify(value)}`)
    })
  }
})

test('startCalendarCapture refuses to run while auto-capture is disabled', async () => {
  await withFlag('0', async () => {
    await assert.rejects(
      () => startCalendarCapture('user-under-test'),
      /auto-capture is disabled on this server/,
    )
  })
})
