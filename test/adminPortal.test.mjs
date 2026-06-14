import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAdminCampaignStatusInput,
  normalizeLeadStatusInput,
} from '../src/adminPortal.mjs'

test('admin can activate a pending_review campaign', () => {
  assert.equal(
    normalizeAdminCampaignStatusInput('pending_review', 'active'),
    'active',
  )
})

test('admin cannot reactivate ended campaign', () => {
  assert.throws(
    () => normalizeAdminCampaignStatusInput('ended', 'active'),
    /Cannot change campaign/,
  )
})

test('lead status must be valid', () => {
  assert.equal(normalizeLeadStatusInput('contacted'), 'contacted')
  assert.throws(() => normalizeLeadStatusInput('spam'), /Lead status/)
})
