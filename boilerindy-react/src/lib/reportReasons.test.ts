import { describe, expect, test } from 'vitest'
import { REPORT_REASONS } from '../../../src/contentReports.mjs'
import { REPORT_REASON_LABELS, REPORT_REASON_OPTIONS, reportReasonLabel } from './reportReasons'

// Issue #192: the reasons are the server's list; only the labels live here, so
// a reason added to src/contentReports.mjs without a label fails this test
// instead of showing its raw value to students.

describe('report reasons', () => {
  test('every reason the API accepts has a label, and no label is left over', () => {
    expect(Object.keys(REPORT_REASON_LABELS).sort()).toEqual([...REPORT_REASONS].sort())
  })

  test('the options follow the server order', () => {
    expect(REPORT_REASON_OPTIONS.map((o) => o.value)).toEqual(REPORT_REASONS)
    expect(REPORT_REASON_OPTIONS[2]).toEqual({ value: 'harassment', label: 'Harassment' })
  })

  test('an unknown stored reason reads as itself', () => {
    expect(reportReasonLabel('scam')).toBe('Scam or fraud')
    expect(reportReasonLabel('legacy')).toBe('legacy')
  })
})
