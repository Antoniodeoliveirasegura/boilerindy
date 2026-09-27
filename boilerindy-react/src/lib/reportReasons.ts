import { REPORT_REASONS } from '../../../src/contentReports.mjs'

// Report reasons as students and admins read them (issue #192). The values
// come from src/contentReports.mjs, which the API validates against, so a form
// can never offer a reason the server rejects; the labels are UI copy.

export const REPORT_REASON_LABELS: Record<string, string> = {
  spam: 'Spam',
  scam: 'Scam or fraud',
  harassment: 'Harassment',
  prohibited: 'Prohibited content',
  other: 'Something else',
}

/** Every reason the API accepts, with its label, in the server's order. */
export const REPORT_REASON_OPTIONS: { value: string; label: string }[] = REPORT_REASONS.map((value: string) => ({
  value,
  label: REPORT_REASON_LABELS[value] ?? value,
}))

/** The label for a stored reason, or the raw value for one this build does not know. */
export function reportReasonLabel(reason: string): string {
  return REPORT_REASON_LABELS[reason] ?? reason
}
