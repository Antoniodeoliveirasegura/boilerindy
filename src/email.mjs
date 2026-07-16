// Minimal transactional email via Resend's HTTP API - no SDK dependency, just
// fetch. Disabled-safe: when RESEND_API_KEY / RESEND_FROM are unset the send is
// skipped and the link is logged to the server console, so local/dev works
// without an email provider (mirrors the Sentry "disabled without DSN" wiring
// in server.mjs). Currently used for the advertiser password-reset flow.
//
// CAN-SPAM (issue #116): `sendEmail` is for TRANSACTIONAL messages only -
// password resets and the like. Those need only accurate routing (a real
// `RESEND_FROM`) and an honest subject, which the reset email has; transactional
// mail is exempt from the unsubscribe / physical-address rules. ANY commercial
// or marketing email (announcements, newsletters, promos) MUST append
// `commercialEmailFooter()` below (postal address + unsubscribe) AND honor a
// suppression list before sending - build that unsubscribe/suppression plumbing
// when the first marketing email is actually added.

const RESEND_API_URL = 'https://api.resend.com/emails'

export function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM)
}

/**
 * Send one transactional email. Resolves with { sent:false, skipped:true } when
 * email is not configured (so callers never crash in dev), throws on a real
 * provider error.
 * @param {{ to: string, subject: string, html: string }} message
 */
export async function sendEmail({ to, subject, html }) {
  if (!isEmailConfigured()) {
    console.warn(`[email] RESEND_API_KEY/RESEND_FROM not set - skipping email to ${to} ("${subject}")`)
    return { sent: false, skipped: true }
  }

  const resp = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM,
      to: [to],
      subject,
      html,
      // noreply@ is send-only; route replies to a monitored inbox (support@) when set.
      ...(process.env.MAIL_REPLY_TO ? { reply_to: process.env.MAIL_REPLY_TO } : {}),
    }),
  })

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`Resend send failed (${resp.status}): ${detail.slice(0, 300)}`)
  }
  const data = await resp.json().catch(() => ({}))
  return { sent: true, id: data?.id || null }
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]),
  )

/**
 * CAN-SPAM footer required on ANY commercial / marketing email - NOT transactional
 * messages (see the module header). Renders the two footer-level things the law
 * requires: a valid physical postal address (from `MAIL_POSTAL_ADDRESS`) and a
 * working unsubscribe link. Throws if either is missing, so a non-compliant
 * marketing email can't be built. Callers must ALSO honor unsubscribes via a
 * suppression list and clearly identify promotional content - those live with
 * the marketing feature itself (issue #116).
 * @param {{ unsubscribeUrl: string }} opts
 * @returns {string} footer HTML to append to a commercial email body
 */
export function commercialEmailFooter({ unsubscribeUrl } = {}) {
  const postal = process.env.MAIL_POSTAL_ADDRESS
  if (!postal) {
    throw new Error(
      'MAIL_POSTAL_ADDRESS is required for commercial email (CAN-SPAM physical-address rule).',
    )
  }
  if (!unsubscribeUrl || typeof unsubscribeUrl !== 'string') {
    throw new Error('unsubscribeUrl is required for commercial email (CAN-SPAM opt-out rule).')
  }
  return `
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center" style="padding:24px 32px;color:#a1a1aa;font-size:12px;line-height:1.6;">
    <p style="margin:0 0 6px;">You're receiving this because you have a BoilerIndy account.</p>
    <p style="margin:0 0 6px;"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#71717a;">Unsubscribe</a> from these emails.</p>
    <p style="margin:0;">${escapeHtml(postal)}</p>
  </td></tr>
</table>`.trim()
}

/** Branded BoilerIndy reset email. Pure - returns the subject + HTML body. */
export function advertiserPasswordResetEmail({ resetUrl, companyName }) {
  const safeUrl = escapeHtml(resetUrl)
  const greeting = companyName ? `Hi ${escapeHtml(companyName)},` : 'Hi there,'
  const subject = 'Reset your BoilerIndy advertiser password'
  const html = `
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f5;padding:32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" role="presentation" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
      <tr><td style="background:#000000;padding:24px 32px;">
        <span style="color:#CFB991;font-size:22px;font-weight:700;letter-spacing:-0.5px;">Boiler<span style="color:#ffffff;">Indy</span></span>
        <span style="color:#a1a1aa;font-size:12px;margin-left:8px;">Advertiser Portal</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 12px;font-size:15px;color:#52525b;">${greeting}</p>
        <h1 style="margin:0 0 12px;font-size:20px;color:#18181b;">Reset your password</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">
          We got a request to reset the password for your BoilerIndy advertiser account. Click the button below to choose a new one. This link expires in 1 hour.
        </p>
        <table cellpadding="0" cellspacing="0" role="presentation"><tr>
          <td style="border-radius:8px;background:#CFB991;">
            <a href="${safeUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#000000;text-decoration:none;border-radius:8px;">Reset password</a>
          </td>
        </tr></table>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#71717a;">If the button doesn't work, paste this link into your browser:</p>
        <p style="margin:6px 0 0;font-size:12px;word-break:break-all;color:#a1a1aa;">${safeUrl}</p>
      </td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid #f4f4f5;">
        <p style="margin:0;font-size:12px;line-height:1.5;color:#a1a1aa;">Didn't request this? You can safely ignore this email - your password won't change.</p>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:11px;color:#a1a1aa;">BoilerIndy · Advertiser Portal</p>
  </td></tr>
</table>`.trim()
  return { subject, html }
}

/** Convenience: build + send the advertiser reset email in one call. */
export function sendAdvertiserPasswordResetEmail({ to, resetUrl, companyName }) {
  const { subject, html } = advertiserPasswordResetEmail({ resetUrl, companyName })
  return sendEmail({ to, subject, html })
}
