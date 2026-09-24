# Documentation index

Feature and ops notes for BoilerIndy, one line per document taken from that
document's own opening paragraph. The repository overview, setup steps and
coding conventions live in the root [README.md](../README.md).

## Documents

- [advertiser-portal.md](advertiser-portal.md) - scope and architecture of the advertiser portal, with M1 (auth, leads) and M2 (campaigns dashboard) shipped.
- [analytics.md](analytics.md) - privacy-conscious usage analytics stored in our own Supabase, with no third-party trackers, no pixel and no external script (issue #51).
- [api-error-codes.md](api-error-codes.md) - the standard JSON error envelope, used by new code and by every code in the table it lists (issue #218).
- [brand.md](brand.md) - the nominative fair use posture that names Purdue only to describe who the app is for and uses none of the university's identity assets (issue #112).
- [client-cache.md](client-cache.md) - the TanStack Query layer in the React app: the public reads persisted to localStorage so the dashboard paints from the last visit, with their keys, stale times, polling and retry rules (issue #251).
- [clubs.md](clubs.md) - the searchable directory of Purdue student organizations behind the `/clubs` page and `GET /api/clubs` (issue #16).
- [dining.md](dining.md) - menus, hours and open/closed status for the two shared dining halls, behind `GET /api/dining` and the `/dining` page (issue #119).
- [error-tracking.md](error-tracking.md) - Sentry reporting from the Express API and the React app, fully off when no DSN is configured (issue #50).
- [keep-warm.md](keep-warm.md) - why Render's free tier spins the backend down after about 15 minutes without a request, and what the app does about the cold start (issue #164).
- [marketplace-photos.md](marketplace-photos.md) - how the app and the website authorize a direct Supabase Storage upload with the student session, up to six ordered photos per listing.
- [parking-status.md](parking-status.md) - live garage availability for Purdue Indianapolis students, behind the `/parking` page, the campus map layer and `GET /api/parking/garages` (issue #14).
- [purdue-link.md](purdue-link.md) - the short-lived, single-use token that lets the native app link a Purdue identity without the `pih.sid` session cookie (issue #214).
- [push-notifications.md](push-notifications.md) - Web Push deadline reminders: the `/settings` card, the `/api/push/` routes behind it, and the reminder runner the Supabase scheduler triggers every 5 minutes (issue #9).
- [RATE_LIMITS.md](RATE_LIMITS.md) - the configurable, in-memory rate limiting that protects the backend, keyed by the signed-in user id when a session exists and otherwise by client IP.
- [schedule-import.md](schedule-import.md) - how a student gets their classes and due dates into BoilerIndy, and why the production path is a pasted link (issue #120).
- [shared-campus-events.md](shared-campus-events.md) - a design note, proposed and not implemented, for campus events that are shared rather than owned by one student's feed.
- [source-resync.md](source-resync.md) - the cron job that re-imports every connected calendar feed on a schedule, instead of only when the student presses Sync (issue #12).

## History

Kept for the record, not maintained:

- [security/security-audit-2026-07-16.md](security/security-audit-2026-07-16.md) - the read-only, multi-agent security review of 2026-07-16. Its findings (#123-#142) were closed by #143 and #144, and the file is kept unedited as history.

## See also

- [../README.md](../README.md) - repository overview, setup and conventions.
- [../SECURITY.md](../SECURITY.md) - the security posture, the dependency audit and the accepted operational risks.
- [../INCIDENT-RESPONSE.md](../INCIDENT-RESPONSE.md) - the runbook for a suspected or confirmed security incident.
