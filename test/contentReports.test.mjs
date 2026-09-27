import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_REPORT_DETAILS,
  parseContentReport,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  REPORT_TARGETS,
} from '../src/contentReports.mjs'
import * as marketplace from '../src/marketplace.mjs'

// Issue #192: one report shape for every surface students post to. The lists
// here are what db/supabase-report-and-block.sql checks and what the website's
// report dialog offers, so they are pinned against the migration too.

const ID = '2f6b7a1e-9c4d-4e8f-8a1b-3c5d7e9f0a2b'
const sql = readFileSync(new URL('../db/supabase-report-and-block.sql', import.meta.url), 'utf8')

// The quoted values of `<column> TEXT ... CHECK (<column> IN (...))` in the migration.
function checkList(column) {
  const match = new RegExp(`${column}\\s+TEXT[^\\n]*CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql)
  assert.ok(match, `no CHECK list for ${column}`)
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

test('the reasons, target types and statuses match the migration\'s CHECK constraints', () => {
  assert.deepEqual(REPORT_REASONS, ['spam', 'scam', 'harassment', 'prohibited', 'other'])
  assert.deepEqual(checkList('reason'), REPORT_REASONS)
  assert.deepEqual(REPORT_TARGET_TYPES, ['board_post', 'board_reply', 'lost_found', 'guide', 'study_group', 'marketplace', 'user'])
  assert.deepEqual(checkList('target_type'), [...REPORT_TARGET_TYPES])
  assert.deepEqual(checkList('status'), [...REPORT_STATUSES])
  assert.equal(MAX_REPORT_DETAILS, 500)
  assert.match(sql, /details\s+TEXT NOT NULL DEFAULT '' CHECK \(char_length\(details\) <= 500\)/)
})

test('the marketplace re-exports the one reason list, so both clients read the same values', () => {
  assert.equal(marketplace.REPORT_REASONS, REPORT_REASONS)
  // The marketplace gains harassment; its reason column is free text.
  assert.deepEqual(marketplace.parseReportInput({ reason: 'harassment' }), { ok: true, reason: 'harassment' })
})

test('every target names its table, author column, soft-delete support and title column', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(REPORT_TARGETS)), {
    board_post: { table: 'board_posts', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' },
    board_reply: { table: 'board_replies', authorColumn: 'user_id', softDelete: false, titleColumn: 'body' },
    lost_found: { table: 'lost_found_items', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' },
    guide: { table: 'guide_recommendations', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' },
    study_group: { table: 'study_groups', authorColumn: 'creator_id', softDelete: true, titleColumn: 'title' },
    marketplace: { table: 'marketplace_listings', authorColumn: 'user_id', softDelete: true, titleColumn: 'title' },
    user: { table: 'users', authorColumn: 'id', softDelete: false, titleColumn: 'display_name' },
  })
  assert.ok(Object.isFrozen(REPORT_TARGETS))
  assert.ok(Object.values(REPORT_TARGETS).every((target) => Object.isFrozen(target)))
})

test('parseContentReport needs a known target type and a UUID target id', () => {
  for (const targetType of [undefined, '', 'comment', 'toString', '__proto__']) {
    assert.deepEqual(parseContentReport({ targetType, targetId: ID, reason: 'spam' }), {
      ok: false,
      message: 'Choose what you are reporting.',
    })
  }
  for (const targetId of [undefined, '', 'abc', `${ID}x`, 42]) {
    assert.deepEqual(parseContentReport({ targetType: 'board_post', targetId, reason: 'spam' }), {
      ok: false,
      message: 'That id is not valid.',
    })
  }
})

test('parseContentReport needs a reason from the list', () => {
  assert.deepEqual(parseContentReport({ targetType: 'guide', targetId: ID }), { ok: false, message: 'Choose a reason for the report.' })
  assert.deepEqual(parseContentReport({ targetType: 'guide', targetId: ID, reason: '   ' }), {
    ok: false,
    message: 'Choose a reason for the report.',
  })
  assert.deepEqual(parseContentReport({ targetType: 'guide', targetId: ID, reason: 'rude' }), {
    ok: false,
    message: 'Reason must be one of: spam, scam, harassment, prohibited, other.',
  })
})

test('parseContentReport normalizes the target and trims and cuts the details', () => {
  assert.deepEqual(parseContentReport({ targetType: ' Board_Post ', targetId: ID.toUpperCase(), reason: ' HARASSMENT ', details: '  keeps posting my name  ' }), {
    ok: true,
    value: { targetType: 'board_post', targetId: ID, reason: 'harassment', details: 'keeps posting my name' },
  })
  const long = parseContentReport({ targetType: 'user', targetId: ID, reason: 'other', details: 'x'.repeat(1200) })
  assert.equal(long.ok, true)
  assert.equal(long.value.details.length, MAX_REPORT_DETAILS)
  assert.deepEqual(parseContentReport({ targetType: 'user', targetId: ID, reason: 'spam' }).value.details, '')
  for (const targetType of REPORT_TARGET_TYPES) {
    assert.equal(parseContentReport({ targetType, targetId: ID, reason: 'other' }).ok, true, targetType)
  }
})
