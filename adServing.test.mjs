import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidAdEventKind,
  isCampaignServable,
  selectServableCampaign,
  toServedAd,
  summarizeAdEvents,
} from './adServing.mjs'

const TODAY = '2026-06-12'

test('isValidAdEventKind accepts impression/tap and rejects others', () => {
  assert.equal(isValidAdEventKind('impression'), true)
  assert.equal(isValidAdEventKind('tap'), true)
  assert.equal(isValidAdEventKind('click'), false)
  assert.equal(isValidAdEventKind(undefined), false)
})

test('isCampaignServable requires active status', () => {
  assert.equal(isCampaignServable({ status: 'active' }, TODAY), true)
  assert.equal(isCampaignServable({ status: 'draft' }, TODAY), false)
  assert.equal(isCampaignServable({ status: 'paused' }, TODAY), false)
  assert.equal(isCampaignServable(null, TODAY), false)
})

test('isCampaignServable respects the date window (null = open-ended)', () => {
  assert.equal(isCampaignServable({ status: 'active', starts_on: '2026-06-01', ends_on: '2026-06-30' }, TODAY), true)
  assert.equal(isCampaignServable({ status: 'active', starts_on: '2026-07-01' }, TODAY), false) // not started
  assert.equal(isCampaignServable({ status: 'active', ends_on: '2026-06-11' }, TODAY), false) // ended yesterday
  assert.equal(isCampaignServable({ status: 'active', starts_on: null, ends_on: null }, TODAY), true)
  assert.equal(isCampaignServable({ status: 'active', ends_on: '2026-06-12' }, TODAY), true) // ends today, still in
})

test('selectServableCampaign returns null when nothing is eligible', () => {
  const campaigns = [
    { id: 'a', status: 'draft' },
    { id: 'b', status: 'active', starts_on: '2026-07-01' },
  ]
  assert.equal(selectServableCampaign(campaigns, TODAY), null)
  assert.equal(selectServableCampaign([], TODAY), null)
})

test('selectServableCampaign picks among only eligible campaigns', () => {
  const campaigns = [
    { id: 'draft', status: 'draft' },
    { id: 'live1', status: 'active' },
    { id: 'expired', status: 'active', ends_on: '2026-01-01' },
    { id: 'live2', status: 'active' },
  ]
  // rng -> 0 picks first eligible (live1); rng -> ~1 picks last eligible (live2)
  assert.equal(selectServableCampaign(campaigns, TODAY, () => 0).id, 'live1')
  assert.equal(selectServableCampaign(campaigns, TODAY, () => 0.999).id, 'live2')
})

test('toServedAd shapes creative and drops unsafe URLs', () => {
  const ad = toServedAd({
    id: 'c1',
    placement: 'home-widget',
    creative: {
      headline: 'Free cold brew',
      body: 'Today only',
      ctaLabel: 'Order',
      ctaUrl: 'https://acme.example.com/x',
      imageUrl: 'javascript:alert(1)',
    },
  })
  assert.deepEqual(ad, {
    campaignId: 'c1',
    placement: 'home-widget',
    headline: 'Free cold brew',
    body: 'Today only',
    imageUrl: null, // unsafe scheme dropped
    ctaLabel: 'Order',
    ctaUrl: 'https://acme.example.com/x',
  })
  assert.equal(toServedAd(null), null)
})

test('summarizeAdEvents counts impressions/taps and computes ctr', () => {
  const events = [
    { kind: 'impression' }, { kind: 'impression' }, { kind: 'impression' }, { kind: 'impression' },
    { kind: 'tap' },
  ]
  assert.deepEqual(summarizeAdEvents(events), { impressions: 4, taps: 1, ctr: 0.25 })
  assert.deepEqual(summarizeAdEvents([]), { impressions: 0, taps: 0, ctr: 0 })
})
