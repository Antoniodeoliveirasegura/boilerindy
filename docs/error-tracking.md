# Error tracking (Sentry)

Issue #50. Both halves of the app report to Sentry's free tier: the Express API
to a Node project, the React app to a React project. With no DSN configured
both are fully off and zero events leave the machine, which is the local
default.

## Setup

| Where | Variable | Purpose |
| --- | --- | --- |
| Render (API) | `SENTRY_DSN` | Node project DSN. Blank disables the backend integration. |
| Vercel (web) | `VITE_SENTRY_DSN` | React project DSN, baked in at build time. Blank disables the client integration. |
| Vercel (build) | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Optional. Lets `@sentry/vite-plugin` upload hidden sourcemaps so production stack traces are readable. Skipped when the token is absent. |

Both `.env.example` files carry the blank entries.

## What is captured

**Backend** (`server.mjs`, top of file): `@sentry/node` with
`captureConsoleIntegration({ levels: ['error'] })`, so every `console.error`
at the roughly eighty catch-and-log sites becomes an event, plus uncaught
exceptions and unhandled rejections. `Sentry.setupExpressErrorHandler(app)`
captures anything that escapes a route handler, ahead of the final
stack-trace-free 500 handler.

**Frontend** (`boilerindy-react/src/main.tsx`): `@sentry/react` is imported
lazily after first paint (`requestIdleCallback`) so it never sits in the
initial bundle. Until it is up, `src/lib/errorReporting.ts` covers the gap:

- `AppErrorBoundary` reports caught render errors through `reportError()`;
- `captureEarlyWindowErrors()` listens for window `error` and
  `unhandledrejection` events from before React renders;
- reports are buffered (at most 20, with a summary event for anything past
  that) and drained in order the moment `attachErrorSink()` runs after
  `Sentry.init`. The window listeners are removed at the same time, because
  Sentry installs its own and nothing should be reported twice.

So a crash during the first render, previously dropped because
`captureException` was still a no-op, now arrives a second or two later.

**Scrubbing**: `src/sentryScrub.mjs` is the shared `beforeSend` on both sides.
It drops user, cookies, auth headers and request bodies, and redacts emails,
JWTs, bearer tokens and hex secrets. Sentry's own identifiers (`event_id`,
`trace_id`, `release`, `debug_meta` and a few more, see `PASSTHROUGH_KEYS`)
are left alone: they have the same hex shape as a secret, and a redacted
`event_id` makes Sentry reject the whole envelope with a 400, which is what
silently dropped every event until 2026-09-14. `sendDefaultPii` is off and
tracing is off (`tracesSampleRate: 0`). Unit tests in `test/sentryScrub.test.mjs`.

## Smoke test

Run this once after a deploy that touches the wiring, and whenever a DSN is
rotated. Each side needs a deliberate error; production produces none
organically.

**Backend**: sign in as an admin, then open

```
https://boilerindy-api.onrender.com/api/admin/sentry-test?confirm=1
```

The response is the generic `{"error":{"message":"Internal server error.","status":500}}`.
One event titled "Sentry smoke test raised via GET /api/admin/sentry-test"
should appear in the Node project within a minute. The route is admin-only and
does nothing without `confirm=1`.

**Frontend**: open https://www.boilerindy.app/, wait a couple of seconds for
Sentry to initialise, then in the DevTools console run

```js
setTimeout(() => { throw new Error('Sentry smoke test') })
```

Sentry's global handler catches the uncaught error and one event should appear
in the React project. Run it from a signed-out tab if you would rather not
attach a session to the event; the scrubber drops user data either way.

## Verifying the early buffer locally

With `VITE_SENTRY_DSN` unset nothing attaches, so the behaviour is covered by
unit tests instead: `boilerindy-react/src/lib/errorReporting.test.ts` and
`boilerindy-react/src/components/AppErrorBoundary.test.tsx`.
