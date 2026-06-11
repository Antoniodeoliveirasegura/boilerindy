# Issue Triage & Implementation Plan

Snapshot date: 2026-06-11. Covers all 32 open issues (#4–#35).

## Status: implemented 2026-06-11 (7 issues)

Live on `main` as `c02fcad` (backend) + `be50592` (frontend).

| Issue | Feature | Notes |
|---|---|---|
| #4 | Dark/Light mode toggle | ThemeContext + navbar/Settings controls, persisted |
| #5 | Search board posts | Title/body/tags, partial match, empty state |
| #6 | Assignment priority labels | High/Med/Low, badges, filter, sort; localStorage per user |
| #7 | Board post editing | Owner-only PATCH + inline UI; run `edited_at` migration in `supabase-board-only.sql` for the persistent "edited" marker |
| #8 | Bulk sync sources | "Sync all" with progress + per-source errors |
| #22 | Rate limiting APIs | `rateLimiter.mjs`; coverage in `docs/RATE_LIMITS.md` |
| #23 | Session expiry UX | `expiresAt` payload, rolling sessions, warning banner, draft preservation |

Follow-ups from that session: run the `edited_at` migration; delete test accounts
`claude.verify.20260611@example.com` / `claude.verify2.20260611@example.com`; pre-existing
bugs found — ICS sync crashes on object-valued `summary` (node-ical), missing
`VITE_SUPABASE_*` env for the frontend client in dev, invalid `GEMINI_API_KEY`.

## Deferred (25 issues), grouped

### A. Quick wins — no external blockers, doable next

| Issue | Feature | Why this bucket |
|---|---|---|
| #35 | Interactive landing background | Frontend-only design work (CSS/canvas aurora, grid, or map motif) |
| #34 | Campus safety layer | Mostly static data + existing Leaflet map overlay |
| #10 | Grade tracker | Self-contained CRUD + GPA math; needs one new Supabase table (or localStorage MVP) |
| #16 | Club calendar sync | Reuses existing ICS sync pipeline once club feed URLs are collected |

### B. Platform/infra projects

| Issue | Feature | Dependencies |
|---|---|---|
| #21 | E2E testing | Playwright already a dep; add test suite + CI workflow |
| #11 | Offline PWA | vite-plugin-pwa, manifest, service worker |
| #9 | Push notifications | Builds on #11's service worker + web-push backend + subscription storage |
| #20 | TypeScript migration | Large but mechanical; migrate incrementally (`allowJs`), new files in TS first |

### C. Blocked on external APIs / credentials

| Issue | Feature | Blocker |
|---|---|---|
| #12 | Brightspace sync (full) | iCal import already works; grades/assignments API needs institutional OAuth access |
| #13 | Study room booking | Purdue/LibCal booking API access |
| #14 | Parking status | No live parking data source identified; static lot map possible as MVP |
| #15 | Rate My Professor | Unofficial API/scraping + ToS review |
| #28 | Nearby restaurants map | Google Places API key + billing |
| #30 | Local events feed | Needs Indy event source aggregation (APIs/scraping) |

### D. Product epics (multi-sprint)

| Issue | Feature | Notes |
|---|---|---|
| #24 | Campus Perks MVP | Admin-managed deals; foundation for #25/#29 |
| #29 | Student deals & coupons | **Near-duplicate of #24** — consolidate |
| #25 | Business self-service portal | Extends #24 with business auth, dashboards, approval workflow |
| #27 | Community marketplace | **Same epic as #32** — consolidate (Sprint 6, estimate 13) |
| #32 | Student marketplace | Listings, moderation, Purdue verification |
| #31 | Neighborhood guide | Student-submitted recs; could reuse board infra |
| #33 | Study group finder | Course matching from existing schedule data + new groups tables |
| #17 | Friend matching | Profiles, matching, privacy controls; after #33 |
| #18 | Degree planner | Blocker is degree-requirement data, not code |
| #19 | Voice input | Web Speech API + Gemini command parsing |
| #26 | Public beta / App Store launch | A gate, not a feature: needs core stability, one Purdue feature (#12/#13/#14), #9, #21 |

## Suggested sequencing

1. **Quick wins:** #35 → #34 → #10 → #16
2. **Platform:** #21 (E2E) → #11 (PWA) → #9 (push) → #20 (TS, ongoing)
3. **Epics:** #24 (close #29 as dup) → #25; merged marketplace (#27 + #32)
4. **External-API features** as access lands: #28, #30, #13, #14, #15, #12
5. **Social:** #33 → #17 → #18 → #19
6. **#26 launch readiness** last — review once 1–3 are largely done

GitHub hygiene suggestion: close #29 as duplicate of #24, and merge #27/#32 into one
epic, leaving ~23 real work items.
