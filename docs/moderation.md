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

A student can also block another student. A block works both ways: the two
stop seeing each other's content, matches and connection requests everywhere
(see [Blocking users](#blocking-users)).

New marketplace photos can be held for an admin before other students see
them, behind `MARKETPLACE_PHOTO_REVIEW` (issue #504): an admin approves or
rejects them at `/admin/photos` (see [Photo review](#photo-review)).

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
- `blocked_users`: one row per block (`blocker_id`, `blocked_id`,
  `created_at`), primary key on the pair and no self-block. The server applies
  each row in both directions (see [Blocking users](#blocking-users)).

Until step 38 runs nothing breaks: `POST /api/reports` answers
`503 content_reports_schema_missing` for everything but a marketplace listing,
whose report keeps working through `marketplace_reports`, the admin Reports
page shows that reporting is not set up yet, the block routes answer
`503 blocked_users_schema_missing`, and every list reads as if nobody had
blocked anyone.

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

## Blocking users

A block works both ways. Once either student blocks the other, neither sees
the other's board posts and replies, lost and found items, guide
recommendations, study groups or marketplace listings, neither appears in the
other's matches or connections, and neither can send the other a connection
request. Blocking also deletes the pair's `connections` rows in both
directions, so an accepted connection or a pending request ends with it;
unblocking does not bring them back. A student can block up to 500 users.

The routes are in `src/routes/blocks.mjs`. All of them need a signed-in
student, and the three writes are limited by `user-write` (see
[RATE_LIMITS.md](RATE_LIMITS.md)).

| Route | Answers |
|---|---|
| `GET /api/me/blocks` | `200 { "blocks": [{ "userId", "displayName", "createdAt" }] }`: the users the caller blocked, newest first. Blocks by other people take effect but are never listed. |
| `POST /api/me/blocks/:userId` | `200 { "ok": true }`, also for a repeat; `400` "You cannot block yourself."; `404` "User not found."; `400` "You have reached the limit of blocked users." |
| `POST /api/me/blocks/content/:targetType/:targetId` | Blocks whoever wrote the content: `200 { "ok": true }`; `400` "You have reached the limit of blocked users."; `400` "Anonymous posts cannot be blocked. Report it instead."; `404` "Not found." for a type other than `board_post`, `board_reply`, `lost_found`, `guide`, `study_group` and `marketplace`. |
| `DELETE /api/me/blocks/:userId` | `200 { "ok": true }`, also when there was no block. |

All four answer `503 blocked_users_schema_missing` before step 38 runs and
`500` "Could not update your blocked users. Please try again." on any other
database failure. A malformed id gets the `404` envelope.

Only friend matching shows user ids; no list of posts names its authors. So
a post is blocked by the post: the by-content route looks the author up on the
server, through the type's table and author column in `REPORT_TARGETS`. It
answers `200 { "ok": true }` whether the content still exists, is the caller's
own or was blocked, so the answer says nothing about who wrote what.

**Anonymous posts cannot be blocked** (owner decision, 2026-09-27). The Blocked
users list names everyone on it, so blocking the author of an anonymous board
post or reply would unmask them. Those answer `400` and are reported instead.
A block made any other way still hides that person's anonymous posts, because
the filter reads `user_id`, which an anonymous post keeps on the server.

### How the lists apply a block

`loadBlockedIds(supabase, userId)` in `src/blocks.mjs` reads every
`blocked_users` row the caller is on either side of, in one query, and returns
the other users as a set. Each list passes that set to
`excludeBlocked(query, column, blocked)`, which adds
`.not(column, 'in', '(...)')` to the query itself, so a page is still a full
page and `hasMore` stays exact. The set is applied on:

- the board: `GET /api/board/posts` (the posts and the reply previews under
  them) and `GET /api/board/posts/:id/replies`, on `user_id`;
- the lost and found, guide and marketplace lists, on `user_id`; a listing's
  detail answers `404` "Listing not found." across a block;
- both study group lists, on `creator_id`;
- friend matching: matches and the connections list skip the other user, and
  `POST /api/connections` gives its usual `{ "ok": true, "status": "pending" }`
  without writing anything (`canReceiveFriendRequest` refuses a blocked pair).

Before step 38 runs the set is empty, so every list works as before. Any other
failure to read it fails the list rather than show a blocked user's content;
lost and found answers its empty `unavailable` list. A post's `replyCount`
still counts replies from blocked users, whose text the thread leaves out.

## What a client needs to call

The website and the native app (boilerindy-app#59) call `POST /api/reports`
with the target type and id of whatever the student is looking at, and show
the answer's message on a `400` or `404`. A `duplicate` answer reads as
success. Only admins call the queue routes.

To block, a client calls `POST /api/me/blocks/content/:targetType/:targetId`
with the same type and id it would report, or `POST /api/me/blocks/:userId`
where it holds a user id (friend matches, connections and requests), then
reloads the list it came from. An anonymous post offers Report only. Settings
lists `GET /api/me/blocks` with an Unblock for each row.

Every row a client offers these on says whether it is the student's own:
`isMine` on board posts and replies, guide recommendations, study groups and
listings, `isOwner` on lost and found items. Board posts and replies also
carry `anon` (replies since #192 PR 3, including the one `POST
/api/board/posts/:id/reply` answers with), so a client can leave Block out on
an anonymous one. None of them carries the author's id.

## On the website

`hooks/useReportAndBlock.tsx` in `boilerindy-react/` holds both actions for
every page, so a new surface only places the buttons.

- **Report** appears on every board post and reply, lost and found item, guide
  recommendation, study group and marketplace listing that is not the
  student's own, and as **Report user** on friend matches and connections. It
  opens the report dialog (`components/ReportDialog.tsx`): the five reasons in
  the server's order (read through `lib/reportReasons.ts`), details asked for
  on "Something else" and optional on the rest, sent to `POST /api/reports`.
  A refusal keeps the dialog open with the server's message; a report or a
  duplicate closes it and shows "Thanks, our team will review it." for a few
  seconds. The listing report goes through this route too, which keeps the
  automatic hide; `POST /api/marketplace/:id/report` stays for older clients.
- **Block author** sits next to Report on board posts and replies, lost and
  found items, guide recommendations, study groups and the listing detail,
  and uses the by-content route after the prompt "Block this author? You will
  no longer see each other's posts." The page then reads its list again, so
  the author's content leaves the screen. An anonymous board post or reply
  offers Report alone.
- **Block** on friend matches, connections and incoming requests blocks the
  person by id after "Block <name>? You will no longer see each other's
  posts, and any connection or request between you ends.", then matches and
  connections are read again.
- **Settings, Blocked users** (after Privacy) lists `GET /api/me/blocks`
  through the `['me', userId, 'blocks']` query (see
  [client-cache.md](client-cache.md)), with Unblock on each row
  (`DELETE /api/me/blocks/:userId`) and "You have not blocked anyone." when
  it is empty. Every block and unblock marks the per-user queries stale, so
  the list is current the next time Settings opens.

## Photo review

New marketplace photos wait for an admin before other students see them
(owner decision, 2026-10-24, issue #504), so the native app's store
submission can say how user-uploaded images are moderated (App Store
guideline 1.2, boilerindy-app#56). Listing text already has the word list,
Report and Block and the takedown; this covers the photos.

### Turning it on

1. Run `db/supabase-marketplace-photo-review.sql` (README "Database setup"
   step 46, needs steps 1 and 13). It adds `marketplace_listings.photos_review`
   (`pending`, `approved` or `rejected`, default `approved`, so every existing
   listing stays as it is), `photos_reviewed_at` and `photos_reviewed_by`.
2. Set `MARKETPLACE_PHOTO_REVIEW=on` on Render and let it restart. The switch
   is off by default, and while it is off nothing changes for students.

With the switch on and step 46 not run, the server warns at boot, and
posting or editing a listing with photos answers
`503 photo_review_schema_missing` (listings without photos still post). No
marketplace read ever needs the columns: without them every listing reads as
approved.

### What waits

With the switch on:

- A listing posted with photos waits (`pending`).
- An edit that adds a photo the listing did not have (a new upload, a new
  image link, a replaced cover) makes it wait again, even when its earlier
  photos were approved. Reordering or removing photos it already had, or
  editing its text, price or status, leaves the state alone.
- Removing every photo from a waiting or rejected listing approves it, since
  nothing is left to review.

With the switch off, a write never names the column, with two exceptions
that only a database with the column can reach: new photos on a rejected
listing are approved (the rejected ones were cleared), and clearing every
photo of a waiting listing approves it. Listings that were already waiting
stay in the queue until an admin decides, so turning the switch off never
shows photos nobody reviewed.

### Who sees what

Every read that returns a listing applies the state through `mapListingRow`
(`src/marketplace.mjs`): `GET /api/marketplace`, `GET /api/marketplace/:id`,
`GET /api/marketplace/mine`, and the listing that `POST /api/marketplace` and
`PATCH /api/marketplace/:id` answer with.

| Photos | Other students | The seller, and admins |
|---|---|---|
| `pending` | `images: []`, `imageUrl: null`, `photosPending: true` | the photos, `photosPending: true`, `photosReview: "pending"` |
| `approved` | the photos, `photosPending: false` | the photos, `photosPending: false`, `photosReview: "approved"` |
| `rejected` | no photos (they were cleared), `photosPending: false` | no photos, `photosPending: false`, `photosReview: "rejected"` |

The listing itself (title, price, description, contact) stays up while its
photos wait; hiding by reports, blocks and soft deletes work as before.

This hides photo URLs from the API; it does not delete or lock files. Photos
already uploaded stay public at their storage links, and a new upload is
public in the bucket from the moment it is uploaded. A managed upload's path
is unguessable (`managed/<seller id>/<time>-<random UUID>.jpg`) and only the
seller and admins are handed it until approval, but anyone with the link can
open it.

### The admin queue

`src/routes/adminPhotoReview.mjs`, admin only (`requireAuth`, then
`requireAdmin`), and the Photo review page at `/admin/photos`, next to
Reports. The overview's "Photos to review" card counts the queue:
`pendingPhotos` in `GET /api/admin/overview`, `null` while step 46 has not
run. The queue works whether the switch is on or off.

`GET /api/admin/photo-review` lists up to 200 live listings with pending
photos, the longest waiting first (by `updated_at`, which every seller edit
moves):

```json
{
  "listings": [
    {
      "id": "<uuid>",
      "title": "Mini fridge",
      "description": "Works, a little loud",
      "category": "furniture",
      "status": "active",
      "hidden": false,
      "createdAt": "2026-10-24T12:00:00+00:00",
      "updatedAt": "2026-10-24T15:04:05.123456+00:00",
      "images": ["https://.../marketplace-images/managed/..."],
      "seller": { "id": "<uuid>", "displayName": "Blake" }
    }
  ]
}
```

`POST /api/admin/photo-review/:id/approve` and
`POST /api/admin/photo-review/:id/reject` (`admin-write` limit, see
[RATE_LIMITS.md](RATE_LIMITS.md)) take the listing's `updatedAt` from the
queue, `{ "updatedAt": "2026-10-24T15:04:05.123456+00:00" }`, so a listing
the seller edited after the queue loaded is never decided on photos the
admin did not see:

| Answer | When |
|---|---|
| `200 { "ok": true, "photosReview": "approved" }`, or `"rejected"` | Decided. |
| `400` "Reload the photo queue and try again." | `updatedAt` is missing or not a date. |
| `404` "No listing with photos waiting for review." | Another admin decided first, the seller removed the photos, or the listing is gone. A malformed id gets the `404` envelope. |
| `409` "The seller changed this listing after the queue loaded. Reload to see the latest photos." | The listing still waits, but was edited after the queue loaded. |
| `503 photo_review_schema_missing` | Step 46 has not run. |

Both record `photos_reviewed_at` and `photos_reviewed_by`; deleting that
admin's account clears `photos_reviewed_by` and keeps the decision. Approve
shows the photos to everyone. Reject clears `image_url` and `image_urls`: the listing stays up
without photos, its seller is told an admin removed them, and new photos
wait again while the switch is on. On the page, Reject asks first, and a
listing waiting longer than a day is marked, like an overdue report.

**Rejected files are left in storage.** Reject removes the listing's
references, not the files. A managed upload that no listing references is
removed by `node scripts/cleanup-marketplace-photos.mjs --apply` once it is a
day old (see [marketplace-photos.md](marketplace-photos.md#cleanup)). That
script stays the one place listing photos are deleted, with its dry run and
its target-host confirmation, rather than a second, unconfirmed delete in a
request handler; the URL was never handed to other students; and an image
link from another site is not ours to delete. For an image that must go at
once, such as nonconsensual intimate imagery, reject it and then delete the
object by hand in the Supabase dashboard (Storage, `marketplace-images`, the
path after `/marketplace-images/` in its URL).

### On the website

- Other students see a "Photos under review" tile where a waiting listing's
  photos would be, on its card and its detail.
- The seller sees "Your photos are waiting for review." on the listing in
  My listings and on its detail, and "An admin removed this listing's photos."
  once they are rejected.

### What the native app needs

A follow-up in boilerindy-app: the same placeholder when `photosPending` is
true and `images` is empty, the seller's note when `isMine` and
`photosPending` are both true, and the removal note when `photosReview` is
`rejected`. A build without them shows a waiting listing like one without
photos (the category tile), which reveals nothing.
