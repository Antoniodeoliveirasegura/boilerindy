# Reporting and moderation

How students report what other students post, and how an admin works the
queue (issue #192). A student can report a board post or reply, a lost and
found item, a guide recommendation, a study group, a marketplace listing, or
another user. Every report lands in one admin queue at `/admin/reports`, where
an admin opens the content, takes it down if it breaks the rules, and resolves
or dismisses the report. The Terms promise human moderation; the working
expectation is that every open report is looked at within 24 hours. Anything
urgent, or anything the app cannot express, goes to `abuse@boilerindy.app`
(the Support page, `/support`, says so).

Blocking users is the second half of #192 and is documented here when it
lands.

## Tables

`db/supabase-report-and-block.sql` (README "Database setup" step 38, needs step
1 only) creates two tables. RLS is on and there are no policies: only the
server, with the service-role key, reads or writes them.

- `content_reports`: one row per reporter per target (`unique (target_type,
  target_id, reporter_id)`). `target_type` is one of `board_post`,
  `board_reply`, `lost_found`, `guide`, `study_group`, `marketplace`, `user`;
  `target_id` is the row's id in that type's table, with no foreign key, so a
  report outlives a purged target. `reason` is one of the reasons below,
  `details` free text up to 500 characters, `status` one of `open`, `resolved`,
  `dismissed`, and `resolved_at` and `resolved_by` record who closed it and
  when.
- `blocked_users`: one row per block (`blocker_id`, `blocked_id`), used by the
  block routes once they land.

Until step 38 runs nothing breaks: `POST /api/reports` answers
`503 content_reports_schema_missing` for everything but a marketplace listing,
whose report keeps working through `marketplace_reports`, and the admin
Reports page shows that reporting is not set up yet.

## Reasons

`src/contentReports.mjs` owns the list and the website reads it from there
(`src/marketplace.mjs` re-exports it), so a form can never offer a reason the
server refuses:

| Reason | Label on the website |
|---|---|
| `spam` | Spam |
| `scam` | Scam or fraud |
| `harassment` | Harassment |
| `prohibited` | Prohibited content |
| `other` | Something else |

`REPORT_TARGETS` in the same module maps each target type to its table, the
column that names its author (`creator_id` for study groups, `id` for a user,
`user_id` everywhere else), whether the table soft-deletes, and the column the
queue shows as its title.

## POST /api/reports

The one report route for every surface. Signed in; limited by `report`
(20 an hour per user, see [RATE_LIMITS.md](RATE_LIMITS.md)).

```json
{ "targetType": "board_post", "targetId": "<uuid>", "reason": "harassment", "details": "optional, up to 500 characters" }
```

| Answer | When |
|---|---|
| `200 { "ok": true }` | The report was filed. |
| `200 { "ok": true, "duplicate": true }` | This student already reported this target; nothing changed. |
| `400` "Choose what you are reporting." | `targetType` is missing or not one of the seven. |
| `400` "That id is not valid." | `targetId` is not a UUID. |
| `400` "Choose a reason for the report." | No `reason`. |
| `400` "Reason must be one of: spam, scam, harassment, prohibited, other." | Any other reason. |
| `400` "You cannot report yourself." | `targetType` is `user` and the id is the caller's. |
| `404` "That content is no longer available." | No such row, or it was taken down (soft-deleting tables are read live only). |
| `400` "You cannot report your own content." | The caller wrote it. |
| `401` | Not signed in. |
| `429` "Too many reports. Please try again in an hour." | Over the `report` limit. |
| `503 content_reports_schema_missing` | Step 38 has not run (not for a listing, above). |
| `500` "Could not send the report. Please try again." | Any other database failure. |

No answer names the author of anything, so reporting an anonymous board post
reveals nothing about who wrote it.

## Marketplace listings

A listing has its own report route from before #192, `POST
/api/marketplace/:id/report` (`board-write` limit), with the same body shape
the marketplace always took (`reason`, optionally `details`, or the flattened
`other: <details>` string) and the same answers. A listing report through
either route goes through `recordListingReport` in `src/marketplaceReports.mjs`,
which writes both tables:

- `marketplace_reports` (`reason: details` in one column), which drives the
  automatic hide: at three distinct reporters the listing is hidden until an
  admin un-hides it or takes it down from Deleted content, "Hidden listings"
  (#204). A second report by the same student is a duplicate and is not
  counted.
- `content_reports` (`target_type` `marketplace`), which puts the report in
  the queue. A duplicate queue row is ignored (an un-hide clears
  `marketplace_reports`, not the queue), and so is a missing table before
  step 38 runs.

## The admin queue

`src/routes/adminReports.mjs`, admin only.

`GET /api/admin/reports?status=open` lists up to 200 reports in one status
(`open` by default, or `resolved` or `dismissed`), newest first:

```json
{
  "reports": [
    {
      "id": "<uuid>",
      "targetType": "board_post",
      "targetId": "<uuid>",
      "reason": "harassment",
      "details": "names a classmate",
      "status": "open",
      "createdAt": "2026-09-27T10:00:00.000Z",
      "reporter": { "id": "<uuid>", "displayName": "Riley" },
      "target": { "title": "Selling my notes", "authorId": "<uuid>", "authorName": "Avery", "deleted": false, "hidden": false }
    }
  ]
}
```

`target` is the reported row as the queue sees it: the title (a reply's body,
a user's display name), the author, whether it was taken down (`deleted_at`
set) and, for a listing, whether reports hid it. It is `null` once the row is
gone for good, or while that feature's table is not installed. A status other
than the three answers `400` "Status must be open, resolved or dismissed."

`PATCH /api/admin/reports/:id` with `{ "status": "resolved" }` or
`{ "status": "dismissed" }` (`admin-write` limit) closes an open report and
records who closed it and when: `200 { "ok": true, "status": "resolved" }`,
`400` "Status must be resolved or dismissed." for anything else, `404` "No open
report with that id." when the report is already closed or does not exist.
Failures on both answer `content_reports_schema_missing` or `500` "Could not
load the reports. Please try again."

### Working a report

On `/admin/reports` each report shows the type, the content, the reason and
details, who reported it and how long ago; one older than a day is marked.

- **Open** previews the live content through `GET
  /api/admin/content/:type/:id` (board posts, lost and found items, guide
  recommendations, study groups and listings). A reply's text and a user's
  name are shown inline instead.
- **Take down** soft-deletes the content through the type's own `DELETE`
  route, or `POST /api/admin/hidden/marketplace/:id/takedown` for a listing,
  so it lands in Deleted content and can be restored. Replies and users have
  no takedown here.
- **Resolve** closes a report that was acted on; **Dismiss** closes one that
  needed nothing. Taking content down does not close its report.

There is no admin block: an admin's tools are the takedown and the queue.

## What a client needs to call

The website and the native app (boilerindy-app#59) call `POST /api/reports`
with the target type and id of whatever the student is looking at, and show
the answer's message on a `400` or `404`. A `duplicate` answer reads as
success. Only admins call the queue routes.
