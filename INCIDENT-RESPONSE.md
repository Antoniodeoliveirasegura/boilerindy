# Incident & Breach Response

A practical runbook for a suspected or confirmed security incident (issue #117).
BoilerIndy is a small student-run app; this is sized for one person to execute,
not an enterprise SOC. Pair it with [SECURITY.md](SECURITY.md).

**Incident commander:** the project owner (you) decides severity, containment,
and whether/when to notify. Security contact: **security@boilerindy.app**.

---

## 1. Severity

| Level | Example | Response |
|---|---|---|
| **SEV1** | Confirmed unauthorized access to the database, a leaked service-role key, or exposed user data | Contain immediately; assume notification is required |
| **SEV2** | A vulnerability that *could* expose data (e.g. a missing `user_id` filter found in review), leaked calendar-feed links | Contain within a day; assess exposure |
| **SEV3** | Suspicious activity, dependency advisory, abuse/spam | Investigate; no notification unless it escalates |

## 2. Detection & alerting

- **Sentry** captures backend + frontend errors, and (issue #50) routes every
  `console.error` to Sentry. Configure a Sentry **alert on error-rate spikes**
  and on new issues in auth / feed / admin routes.
- Watch for: bursts of 401/403, unusual `/feeds/calendar/*` traffic, failed
  admin actions, Supabase auth anomalies, and Render/Vercel deploy alerts.
- Rate limiters (`src/rateLimiter.mjs`) blunt brute force; a spike in limiter
  hits is itself a signal.

## 3. Response workflow

**Detect → Triage → Contain → Eradicate → Notify → Recover → Review.**
Start a timestamped log (what you saw, did, and when) at the first sign - you'll
need the timeline for any notification and the post-mortem.

## 4. Containment runbook (runnable)

Do the steps relevant to the incident. Prod = **Supabase** (DB) + **Render**
(backend) + **Vercel** (frontend); secrets live in the Render/Vercel dashboards,
never in the repo.

**a. Rotate the Supabase keys** (service-role leak, or any DB compromise)
- Supabase → Settings → API → **roll** the `service_role` and `anon` keys.
- Update `SUPABASE_SERVICE_ROLE_KEY` on Render and `VITE_SUPABASE_ANON_KEY` on
  Vercel; redeploy both. The old keys stop working immediately.

**b. Log everyone out** (session/cookie compromise)
- Rotate `SESSION_SECRET` on Render and redeploy. Existing `pih.sid` cookies no
  longer verify, so all server sessions are invalidated. (Sessions are in-memory,
  so a redeploy/restart already clears them.)
- In Supabase → Authentication, revoke active sessions if the Supabase-Auth side
  is implicated.

**c. Revoke all calendar-feed links** (feed-token exposure)
- Supabase SQL editor: `UPDATE users SET calendar_feed_token = NULL;`
  Every `/feeds/calendar/<token>.ics` link stops resolving; users re-create
  theirs in Settings.

**d. Invalidate outstanding password-reset tokens** (auth-store compromise)
- Supabase SQL editor: `DELETE FROM advertiser_password_resets;`

**e. Rotate any other exposed secret**
- `RESEND_API_KEY`, `GEMINI_API_KEY`, `TRANSLOC_API_KEY`, `SENTRY_DSN` - roll at
  the provider, update the host env, redeploy.

**f. Cut off a specific abused surface**
- Temporarily disable an endpoint (feature flag / comment the route + redeploy)
  or tighten its rate limiter via `RATE_LIMIT_*` env vars.

## 5. What data is at risk (inventory)

| Data | Where | Sensitivity |
|---|---|---|
| Email, display name, avatar, auth provider | `users` | Medium (PII) |
| Purdue email + username (never the password) | `users` | Medium |
| Imported schedule: class/assignment/exam titles, times, **locations**, raw ICS | `calendar_items` (incl. `raw_json`) | **High** - reveals where a student physically is |
| Grades | `user_grades` | High |
| Posts: board, marketplace (name + Purdue email shown), lost & found, guide, study groups, friend profile | respective tables | Medium |
| Calendar-feed token (bearer capability) | `users.calendar_feed_token` | High |
| Advertiser accounts + scrypt password hashes | `advertisers` | High |
| Usage analytics events | `analytics_events` | Low |

**Not collected:** SSN, driver's-license, or financial-account numbers.

## 6. Legal notification (Indiana)

Indiana's breach law, **IC 24-4.9**, is triggered by unauthorized acquisition of
unencrypted **"personal information"** - defined narrowly as a name **plus** an
SSN, driver's-license number, or financial-account/card number. BoilerIndy does
**not** collect those for students, so a breach of schedule/email/post data
likely falls **outside** IC 24-4.9's strict trigger.

Even so:
- **Notify affected users anyway** for any real exposure of their data - it's
  the right thing, our privacy policy implies it, and the FTC treats deceptive
  security claims as unfair/deceptive practices.
- **Advertiser credentials** (emails + password hashes) or any future collection
  of regulated identifiers **could** trigger IC 24-4.9 - which then requires
  notifying affected Indiana residents **and the Indiana Attorney General**
  without unreasonable delay.
- **Confirm the specific obligation with counsel** before deciding not to notify.
  Do not treat this file as a legal determination.

## 7. User notification template

> **Subject: Important security notice about your BoilerIndy account**
>
> Hi {first name},
>
> On {date} we discovered {plain-language what happened}. Your {data involved -
> e.g. email address and class schedule} may have been exposed. We have {what we
> did - e.g. rotated all keys and invalidated calendar-feed links}.
>
> As a precaution, please {action - e.g. reset your password / re-create your
> calendar link in Settings}. We do not collect passwords for social logins, and
> we never store your Purdue password.
>
> We're sorry this happened. Questions: security@boilerindy.app.
>
> - The BoilerIndy team

## 8. Post-incident review

Within a week of resolution, write a short blameless post-mortem: timeline, root
cause, what data was actually affected, what stopped it, and the follow-ups
(e.g. a new test, an RLS check, a rate-limit change). File the follow-ups as
issues so they don't get lost.
