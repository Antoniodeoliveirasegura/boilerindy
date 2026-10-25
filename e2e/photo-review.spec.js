import { test, expect, sampleListings } from './fixtures/mock-backend.js'

// Marketplace photo review (#504) on the website, against the mocked API. New
// listing photos wait for an admin before other students see them: the admin
// console counts them on the overview and lists them on the Photo review page,
// where an admin approves one listing's photos and rejects another's after
// confirming. Other students see a placeholder where waiting photos would be,
// the seller sees their photos with a note, and everyone gets the photos once
// they are approved.

// A second photo, so the queue shows a whole gallery.
const SECOND_PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function listingsWithPhotos() {
  const [textbook, lamp, pass] = sampleListings()
  return [
    { ...textbook, images: [textbook.imageUrl, SECOND_PHOTO] },
    { ...lamp, imageUrl: SECOND_PHOTO, images: [SECOND_PHOTO] },
    pass,
  ]
}

const queueRow = (page, title) => page.locator('[data-review-listing]', { hasText: title })
const adminNav = (page) => page.getByRole('navigation', { name: 'Admin navigation' })

test.describe('Marketplace photo review', () => {
  test('an admin approves one listing\'s photos and rejects another\'s, from the overview count to an empty queue', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.setUser({ isAdmin: true })
    mockApi.seedMarketplace({ listings: listingsWithPhotos() })
    mockApi.seedPhotoReview([{ id: 'listing-1', hoursAgo: 30 }, { id: 'listing-2' }])

    await page.goto('/admin')
    const count = page.getByRole('link', { name: /Photos to review/ })
    await expect(count).toContainText('2')
    await count.click()
    await expect(page).toHaveURL(/\/admin\/photos$/)
    await expect(page.getByRole('heading', { name: 'Photo review' })).toBeVisible()
    await expect(adminNav(page).getByRole('link', { name: 'Photo review' })).toHaveAttribute('aria-current', 'page')

    // The longest waiting first, with every photo, its seller and its wait.
    await expect(page.locator('[data-review-listing]')).toHaveCount(2)
    await expect(page.locator('[data-review-listing]').first()).toContainText('Calculus textbook, 9th edition')
    const textbook = queueRow(page, 'Calculus textbook')
    await expect(textbook.getByRole('img', { name: /^Calculus textbook, 9th edition photo \d$/ })).toHaveCount(2)
    await expect(textbook).toContainText('Posted by Riley Boilermaker')
    await expect(textbook).toContainText('(1 day ago)')

    await queueRow(page, 'Desk lamp').getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByText('Photos approved. Every student can see them now.')).toBeVisible()
    await expect(queueRow(page, 'Desk lamp')).toHaveCount(0)

    await textbook.getByRole('button', { name: 'Reject' }).click()
    const dialog = page.getByRole('dialog', { name: 'Reject these photos?' })
    await expect(dialog).toContainText('stays up without photos')
    await dialog.getByRole('button', { name: 'Reject photos' }).click()
    await expect(page.getByText('Photos rejected and removed from the listing.')).toBeVisible()
    await expect(page.getByText('Nothing to review')).toBeVisible()

    // Each decision carried the version the queue showed, which the mock checks like the server.
    expect(mockApi.state.marketplace.photoDecisions.map(({ id, decision }) => [id, decision])).toEqual([
      ['listing-2', 'approve'],
      ['listing-1', 'reject'],
    ])
    const [rejected, approved] = mockApi.state.marketplace.listings
    expect(rejected).toMatchObject({ photosReview: 'rejected', images: [], imageUrl: null })
    expect(approved).toMatchObject({ photosReview: 'approved', images: [SECOND_PHOTO] })

    await adminNav(page).getByRole('link', { name: 'Overview' }).click()
    await expect(page.getByRole('link', { name: /Photos to review/ })).toContainText('0')
  })

  test('other students see a placeholder where waiting photos would be, the seller sees a note, and approved photos show to everyone', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedMarketplace({ listings: listingsWithPhotos() })
    mockApi.seedPhotoReview([{ id: 'listing-1' }, { id: 'listing-2' }])
    await page.goto('/marketplace')

    const textbook = page.locator('[data-listing-id="listing-1"]')
    await expect(textbook.locator('[data-listing-image]')).toHaveAttribute('data-listing-image', 'pending')
    await expect(textbook).toContainText('Photos under review')
    await expect(textbook.locator('img')).toHaveCount(0)
    await textbook.getByRole('button').first().click()
    const detail = page.locator('[data-listing-detail="listing-1"]')
    await expect(detail).toContainText('Photos under review')
    await expect(detail.locator('img')).toHaveCount(0)

    // The seller still sees their own photo, and why other students do not.
    await page.getByRole('button', { name: 'My listings' }).click()
    const lamp = page.locator('[data-listing-id="listing-2"]')
    await expect(lamp.locator('[data-listing-image]')).toHaveAttribute('data-listing-image', 'photo')
    await expect(lamp.locator('[data-photos-note]')).toContainText('Your photos are waiting for review.')

    // Once an admin approves them, every student gets the photos.
    mockApi.state.marketplace.listings[0].photosReview = 'approved'
    await page.reload()
    await expect(page.locator('[data-listing-id="listing-1"] [data-listing-image]')).toHaveAttribute('data-listing-image', 'photo')
    await expect(page.locator('[data-listing-id="listing-1"]')).not.toContainText('Photos under review')
  })
})
