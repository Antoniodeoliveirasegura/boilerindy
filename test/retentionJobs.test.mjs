import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Issue #528 - the Privacy page promises raw usage analytics are kept at most
// 12 months, and nothing deleted them: docs/analytics.md asked the owner to run
// the DELETE by hand. db/supabase-retention.sql schedules the deletes; these
// tests pin each job to its table and window, and the analytics window to the
// one the Privacy page states.

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const sql = read('db/supabase-retention.sql')

// Every select cron.schedule('<name>', '<cron>', $$<command>$$); in the file.
const jobs = [...sql.matchAll(/select cron\.schedule\(\s*'([^']+)',\s*'([^']+)',[^$]*\$\$([\s\S]*?)\$\$\s*\);/g)].map(
  ([, name, schedule, command]) => ({ name, schedule, command: command.trim() }),
)

test('schedules one job per table, each deleting only rows past its window', () => {
  assert.deepEqual(
    jobs.map((j) => j.name),
    [
      'boilerindy-retention-analytics',
      'boilerindy-retention-push-deliveries',
      'boilerindy-retention-sessions',
      'boilerindy-retention-push-tickets',
      'boilerindy-retention-campus-alert-messages',
      'boilerindy-retention-campus-alert-incidents',
      'boilerindy-retention-live-activities',
      'boilerindy-retention-cron-history',
    ],
  )
  assert.deepEqual(
    jobs.map((j) => j.command.replace(/\s+/g, ' ')),
    [
      "DELETE FROM analytics_events WHERE created_at < NOW() - INTERVAL '12 months'",
      "DELETE FROM push_deliveries WHERE sent_at < NOW() - INTERVAL '60 days'",
      'DELETE FROM user_sessions WHERE expire < NOW()',
      // Expo push tickets (issue #550): a receipt is gone from Expo after 24 hours.
      "DELETE FROM push_tickets WHERE sent_at < NOW() - INTERVAL '2 days'",
      // Campus alerts (issue #550, item 9): a year, like the analytics; an
      // incident goes once no message names it.
      "DELETE FROM campus_alert_messages WHERE sent_at < NOW() - INTERVAL '12 months'",
      "DELETE FROM campus_alert_incidents i WHERE i.opened_at < NOW() - INTERVAL '12 months' AND NOT EXISTS (SELECT 1 FROM campus_alert_messages m WHERE m.incident_id = i.id)",
      // Track this bus (issue #550): a day past each activity's 30 minutes.
      "DELETE FROM live_activities WHERE ends_at < NOW() - INTERVAL '1 day'",
      "DELETE FROM cron.job_run_details WHERE start_time < NOW() - INTERVAL '7 days'",
    ],
  )
})

test('the analytics window is the one the Privacy page promises, and runs daily', () => {
  assert.match(read('boilerindy-react/src/pages/Privacy.tsx'), /kept at most\s+12 months/)
  const analytics = jobs.find((j) => j.name === 'boilerindy-retention-analytics')
  assert.ok(analytics, 'no analytics retention job')
  assert.match(analytics.command, /INTERVAL '12 months'/)
  // Daily, so no event outlives the promise by more than a day.
  assert.equal(analytics.schedule, '0 4 * * *')
})
