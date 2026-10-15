import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCampaignInput,
  normalizeCampaignPatch,
  normalizeCreative,
  assertBannerCreative,
  safeHttpUrl,
  mapCampaignRow,
  isValidPlacement,
  ADVERTISER_STATUS_TRANSITIONS,
} from '../src/advertiserCampaign.mjs'

test('isValidPlacement accepts known placements and rejects others', () => {
  assert.equal(isValidPlacement('home-widget'), true)
  assert.equal(isValidPlacement('side-rail'), true)
  assert.equal(isValidPlacement('billboard'), false)
})

test('safeHttpUrl accepts http/https and rejects javascript: and garbage', () => {
  assert.equal(safeHttpUrl('https://acme.com/x'), 'https://acme.com/x')
  assert.throws(() => safeHttpUrl('javascript:alert(1)', 'CTA URL'), /http:\/\/ or https:\/\//)
  assert.throws(() => safeHttpUrl('not a url'), /valid URL/)
})

test('normalizeCampaignInput returns shaped fields for a valid campaign', () => {
  const result = normalizeCampaignInput({
    name: '  Fall promo  ',
    placement: 'home-widget',
    startsOn: '2026-09-01',
    endsOn: '2026-09-30',
    creative: { headline: '  Hi  ', ctaUrl: 'https://acme.com' },
  })
  assert.equal(result.name, 'Fall promo')
  assert.equal(result.placement, 'home-widget')
  assert.equal(result.startsOn, '2026-09-01')
  assert.equal(result.endsOn, '2026-09-30')
  assert.deepEqual(result.creative, { headline: 'Hi', ctaUrl: 'https://acme.com/' })
})

test('normalizeCampaignInput requires a name and a valid placement', () => {
  assert.throws(() => normalizeCampaignInput({ name: '', placement: 'home-widget' }), /name is required/)
  assert.throws(() => normalizeCampaignInput({ name: 'X', placement: 'nope' }), /Placement must be one of/)
})

test('normalizeCampaignInput rejects end-before-start and bad date format', () => {
  assert.throws(
    () => normalizeCampaignInput({ name: 'X', placement: 'dining', startsOn: '2026-09-30', endsOn: '2026-09-01' }),
    /End date must be on or after/,
  )
  assert.throws(
    () => normalizeCampaignInput({ name: 'X', placement: 'dining', startsOn: '09/01/2026' }),
    /YYYY-MM-DD/,
  )
})

test('normalizeCreative caps length and rejects unsafe cta url', () => {
  assert.throws(() => normalizeCreative({ headline: 'x'.repeat(121) }), /headline must be/)
  assert.throws(() => normalizeCreative({ ctaUrl: 'javascript:alert(1)' }), /http/)
})

test('normalizeCreative accepts imageUrls array and syncs imageUrl', () => {
  const c = normalizeCreative({
    imageUrls: [
      'https://img.example/1.jpg',
      'https://img.example/2.jpg',
      'https://img.example/3.jpg',
    ],
    ctaUrl: 'https://acme.com',
  })
  assert.equal(c.imageUrl, 'https://img.example/1.jpg')
  assert.equal(c.imageUrls.length, 3)
  assert.equal(c.ctaUrl, 'https://acme.com/')
})

test('assertBannerCreative requires 3 photos and website for banner placements', () => {
  assert.throws(
    () => assertBannerCreative({ imageUrls: ['https://a.com/1.jpg'] }, 'side-rail'),
    /at least 3 photo/,
  )
  assert.throws(
    () => assertBannerCreative({
      imageUrls: ['https://a.com/1.jpg', 'https://a.com/2.jpg', 'https://a.com/3.jpg'],
    }, 'side-rail'),
    /website URL/,
  )
})

test('normalizeCreative drops unknown keys and blank fields', () => {
  const c = normalizeCreative({ headline: 'Hi', evil: 'x', body: '   ' })
  assert.deepEqual(c, { headline: 'Hi' })
})

test('advertiser CAN submit a draft for review', () => {
  const patch = normalizeCampaignPatch({ status: 'pending_review' }, { status: 'draft' })
  assert.deepEqual(patch, { status: 'pending_review' })
})

test('advertiser CANNOT self-activate a draft or pending_review (approval gate)', () => {
  assert.throws(
    () => normalizeCampaignPatch({ status: 'active' }, { status: 'draft' }),
    /must be approved before it can go live/,
  )
  assert.throws(
    () => normalizeCampaignPatch({ status: 'active' }, { status: 'pending_review' }),
    /must be approved before it can go live/,
  )
})

test('advertiser CAN pause an active campaign and resume a paused one', () => {
  assert.deepEqual(normalizeCampaignPatch({ status: 'paused' }, { status: 'active' }), { status: 'paused' })
  assert.deepEqual(normalizeCampaignPatch({ status: 'active' }, { status: 'paused' }), { status: 'active' })
})

// An approved campaign could be paused, given a new link, photos or copy, and
// resumed, so students saw content the owner never reviewed. Changing what
// students see now sends it back to draft; pause, resume, a rename and new
// dates keep the approval.
const APPROVED_CREATIVE = {
  headline: 'Half off lattes',
  body: 'All week',
  ctaLabel: 'Visit website',
  ctaUrl: 'https://cafe.example/',
  imageUrls: ['https://img.example/1.jpg', 'https://img.example/2.jpg', 'https://img.example/3.jpg'],
  imageUrl: 'https://img.example/1.jpg',
}
const approvedRow = (status) => ({ status, placement: 'side-rail', creative: APPROVED_CREATIVE })

test('editing the banner of a paused or live campaign sends it back to draft', () => {
  for (const status of ['paused', 'active']) {
    const swappedLink = normalizeCampaignPatch(
      { creative: { ...APPROVED_CREATIVE, ctaUrl: 'https://never-reviewed.example/landing' } },
      approvedRow(status),
    )
    assert.equal(swappedLink.status, 'draft', `a new link on a ${status} campaign`)
    assert.equal(swappedLink.creative.ctaUrl, 'https://never-reviewed.example/landing')

    const photos = ['https://img.example/9.jpg', 'https://img.example/2.jpg', 'https://img.example/3.jpg']
    assert.equal(
      normalizeCampaignPatch({ creative: { ...APPROVED_CREATIVE, imageUrls: photos } }, approvedRow(status)).status,
      'draft',
      `a new photo on a ${status} campaign`,
    )
    assert.equal(
      normalizeCampaignPatch({ creative: { ...APPROVED_CREATIVE, headline: 'UNREVIEWED headline' } }, approvedRow(status)).status,
      'draft',
      `new copy on a ${status} campaign`,
    )
    assert.equal(
      normalizeCampaignPatch({ placement: 'home-widget' }, approvedRow(status)).status,
      'draft',
      `a new placement on a ${status} campaign`,
    )
  }
})

test('the pause, edit, resume path can no longer put unreviewed content live', () => {
  const paused = { ...approvedRow('active'), ...normalizeCampaignPatch({ status: 'paused' }, approvedRow('active')) }
  const edit = normalizeCampaignPatch({ creative: { ...APPROVED_CREATIVE, headline: 'UNREVIEWED headline' } }, paused)
  const afterEdit = { ...paused, ...edit }
  assert.equal(afterEdit.status, 'draft')
  assert.throws(() => normalizeCampaignPatch({ status: 'active' }, afterEdit), /must be approved before it can go live/)
})

test('a banner change cannot ride along with a status change on an approved campaign', () => {
  const creative = { ...APPROVED_CREATIVE, ctaUrl: 'https://never-reviewed.example/' }
  for (const status of ['active', 'paused', 'ended']) {
    assert.throws(
      () => normalizeCampaignPatch({ creative, status }, approvedRow('paused')),
      /send it back to draft for review/,
      `creative with status ${status}`,
    )
  }
  assert.equal(normalizeCampaignPatch({ creative, status: 'draft' }, approvedRow('paused')).status, 'draft')
})

// The edit form fills in "Visit website" for a banner stored with no link
// label, which is also what students see for it. A dates-only save of such an
// approved banner used to count as a new banner and send it back to draft.
test('an approved banner with no label of its own keeps its status when saved unchanged', () => {
  const { ctaLabel: _label, ...unlabelled } = APPROVED_CREATIVE
  const row = { status: 'paused', placement: 'side-rail', creative: unlabelled }
  const saved = normalizeCampaignPatch({ startsOn: '2026-11-01', creative: { ...unlabelled, ctaLabel: 'Visit website' } }, row)
  assert.notEqual(saved.status, 'draft')
  // A label students would actually see differently still reopens review.
  assert.equal(normalizeCampaignPatch({ creative: { ...unlabelled, ctaLabel: 'Order now' } }, row).status, 'draft')
})

test('an approved campaign keeps its status for a rename, new dates or an unchanged banner', () => {
  // The dashboard's edit form sends every field, the creative included.
  const sameForm = {
    name: 'Renamed promo',
    placement: 'side-rail',
    startsOn: '2026-11-01',
    endsOn: '2026-11-30',
    creative: {
      headline: 'Half off lattes',
      body: 'All week',
      ctaLabel: 'Visit website',
      ctaUrl: 'https://cafe.example/',
      imageUrls: APPROVED_CREATIVE.imageUrls,
    },
  }
  for (const status of ['paused', 'active']) {
    const patch = normalizeCampaignPatch(sameForm, approvedRow(status))
    assert.equal('status' in patch, false, `a ${status} campaign`)
    assert.equal(patch.name, 'Renamed promo')
  }
  // A legacy single-photo row compares by the photo it serves.
  const legacy = { status: 'paused', placement: 'dining', creative: { imageUrl: 'https://img.example/1.jpg' } }
  assert.equal('status' in normalizeCampaignPatch({ creative: { imageUrls: ['https://img.example/1.jpg'] } }, legacy), false)
})

test('drafts and campaigns in review keep their status when the banner changes', () => {
  const creative = { ...APPROVED_CREATIVE, headline: 'New headline' }
  assert.equal('status' in normalizeCampaignPatch({ creative }, approvedRow('draft')), false)
  assert.equal('status' in normalizeCampaignPatch({ creative }, approvedRow('pending_review')), false)
})

test('ended is terminal - no transitions allowed', () => {
  assert.deepEqual(ADVERTISER_STATUS_TRANSITIONS.ended, [])
  assert.throws(() => normalizeCampaignPatch({ status: 'draft' }, { status: 'ended' }), /can't change/)
})

test('normalizeCampaignPatch validates merged date order against the current row', () => {
  assert.throws(
    () => normalizeCampaignPatch({ endsOn: '2026-01-01' }, { status: 'draft', starts_on: '2026-06-01' }),
    /End date must be on or after/,
  )
})

test('normalizeCampaignPatch throws when nothing valid is provided', () => {
  assert.throws(() => normalizeCampaignPatch({}, { status: 'draft' }), /No valid fields/)
})

test('mapCampaignRow shapes the DB row to client JSON', () => {
  const row = {
    id: 'c1',
    advertiser_id: 'adv1',
    name: 'Promo',
    placement: 'home-widget',
    status: 'draft',
    starts_on: '2026-09-01',
    ends_on: null,
    creative: { headline: 'Hi' },
    created_at: '2026-06-12T00:00:00Z',
    updated_at: '2026-06-12T00:00:00Z',
  }
  const mapped = mapCampaignRow(row)
  assert.deepEqual(mapped, {
    id: 'c1',
    name: 'Promo',
    placement: 'home-widget',
    status: 'draft',
    startsOn: '2026-09-01',
    endsOn: null,
    creative: { headline: 'Hi' },
    createdAt: '2026-06-12T00:00:00Z',
    updatedAt: '2026-06-12T00:00:00Z',
  })
  assert.equal('advertiser_id' in mapped, false)
  assert.equal(mapCampaignRow(null), null)
})
