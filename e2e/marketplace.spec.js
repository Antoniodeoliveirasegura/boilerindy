import { test, expect, sampleListings } from './fixtures/mock-backend.js'

// Marketplace photos (#171) and galleries / pricing (#177) on the website.
// Drives the real /marketplace page against the mocked API and a mocked
// Supabase Storage: listings render their cover the way the app does, a seller
// attaches a photo when posting (the browser re-encodes it, PUTs it to Storage,
// and sends the receipt inside the ordered photos list), edits an existing
// listing's photos, adds image links, picks Free / Best offer, sees the
// server's message when photo storage is off, and can retry a failed upload.

// A real JPEG drawn in the page, so the browser-side re-encode has something to decode.
async function jpegFixture(page, name = 'desk.jpg') {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 48
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#c28e0e'
    ctx.fillRect(0, 0, 48, 32)
    ctx.fillStyle = '#222222'
    ctx.fillRect(8, 8, 16, 16)
    return canvas.toDataURL('image/jpeg', 0.9)
  })
  return { name, mimeType: 'image/jpeg', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') }
}

const photoStatus = (page) => page.locator('[data-photo-status]')
const photoMessage = (page) => page.locator('[data-photo-message]')
const card = (page, id) => page.locator(`[data-listing-id="${id}"]`)

// The fixture is 48 px wide; seeing that width back proves the bytes that were
// uploaded are the bytes the bucket serves, not just that some image loaded.
// Works for a card (tile with the cover on top) and for the detail gallery.
async function expectRenderedPhoto(locator) {
  const img = locator.locator('img').first()
  await expect(img).toHaveAttribute('src', /marketplace-images\/managed\//)
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(48)
}

test.describe('Marketplace photos', () => {
  test('listings show their photo, price and category like the app; the detail shows a hero', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/marketplace')

    await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible()
    const textbook = card(page, 'listing-1')
    await expect(textbook).toContainText('$45')
    await expect(textbook).toContainText('Textbooks')
    await expect(textbook.locator('[data-listing-image]')).toHaveAttribute('data-listing-image', 'photo')
    await expect(textbook.locator('img')).toHaveCount(1)

    // No photo: the category tile stands in, and prices read like the app.
    const lamp = card(page, 'listing-2')
    await expect(lamp).toContainText('$12.50')
    await expect(lamp.locator('[data-listing-image]')).toHaveAttribute('data-listing-image', 'placeholder')
    await expect(card(page, 'listing-3')).toContainText('Free')

    await textbook.getByRole('button').first().click()
    const detail = page.locator('[data-listing-detail="listing-1"]')
    await expect(detail).toContainText('Calculus textbook, 9th edition')
    // The detail shows the whole gallery, the way the app does.
    await expect(detail.locator('[data-listing-gallery]')).toHaveAttribute('data-listing-gallery', '1')
    await expect(detail.getByAltText('Calculus textbook, 9th edition photo 1')).toBeVisible()
    await expect(detail.getByRole('link', { name: 'riley@purdue.edu' })).toBeVisible()
  })

  test('posting with a photo uploads it to Storage and attaches it by receipt', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/marketplace')
    await page.getByRole('button', { name: 'Post a listing' }).click()
    await page.getByLabel('Title').fill('Standing desk')
    await page.getByLabel('Price in dollars').fill('80')
    await page.locator('[data-listing-form]').getByRole('group', { name: 'Category' }).getByRole('button', { name: 'Furniture' }).click()

    await page.getByLabel('Listing photo').setInputFiles(await jpegFixture(page))
    await expect(photoStatus(page)).toHaveAttribute('data-photo-status', 'ready')
    await expect(photoMessage(page)).toContainText('Photo ready')
    await expect(page.locator('[data-photo-preview]')).toBeVisible()
    await expect(page.locator('[data-photo-status]')).toHaveAttribute('data-photo-count', '1')
    expect(mockApi.state.marketplace.uploads.size).toBe(1)

    await page.getByRole('button', { name: 'Post listing' }).click()
    await expect(page.locator('[data-listing-form]')).toHaveCount(0)

    const created = mockApi.state.marketplace.listings[0]
    expect(created.title).toBe('Standing desk')
    expect(created.imageUrl).toMatch(/marketplace-images\/managed\//)
    expect(created.images).toEqual([created.imageUrl])
    const body = mockApi.state.marketplace.bodies.at(-1).body
    expect(body.photos).toEqual([{ receipt: expect.stringMatching(/^receipt-/) }])
    expect(body).not.toHaveProperty('imageUrl')
    expect(body).not.toHaveProperty('imageUploadReceipt')
    expect(body.priceMode).toBe('fixed')
    expect(body.priceCents).toBe(8000)
    expect(body.category).toBe('furniture')

    await expect(card(page, created.id).locator('[data-listing-image]')).toHaveAttribute('data-listing-image', 'photo')
    await expectRenderedPhoto(card(page, created.id))

    // The detail gallery shows the same photo, served from the bucket URL.
    await card(page, created.id).getByRole('button').first().click()
    const detail = page.locator(`[data-listing-detail="${created.id}"]`)
    await expect(detail).toContainText('Standing desk')
    await expectRenderedPhoto(detail)
  })

  test('editing a listing replaces its photo, bound to that listing, and can remove it', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/marketplace')
    await page.getByRole('button', { name: 'My listings' }).click()
    await card(page, 'listing-2').getByRole('button', { name: 'Edit' }).click()

    const form = page.locator('[data-listing-form="edit"]')
    await expect(form.getByRole('heading', { name: 'Edit listing' })).toBeVisible()
    await expect(page.getByLabel('Title')).toHaveValue('Desk lamp')
    await expect(page.getByLabel('Price in dollars')).toHaveValue('12.50')

    await page.getByLabel('Listing photo').setInputFiles(await jpegFixture(page, 'lamp.jpg'))
    await expect(photoStatus(page)).toHaveAttribute('data-photo-status', 'ready')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.locator('[data-listing-form]')).toHaveCount(0)

    const receipts = [...mockApi.state.marketplace.receipts.values()]
    expect(receipts.at(-1).listingId).toBe('listing-2')
    expect(mockApi.state.marketplace.bodies.at(-1).body).toEqual({ photos: [{ receipt: expect.stringMatching(/^receipt-/) }] })
    await expectRenderedPhoto(card(page, 'listing-2'))

    // Remove: the form lists the current photo as a link; clearing the box sends an empty gallery.
    await card(page, 'listing-2').getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByLabel('Image links')).toHaveValue(/marketplace-images\/managed\//)
    await expect(photoMessage(page)).toContainText('1 photo from links')
    await page.getByLabel('Image links').fill('')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.locator('[data-listing-form]')).toHaveCount(0)
    expect(mockApi.state.marketplace.bodies.at(-1).body).toEqual({ photos: [] })
    const cleared = mockApi.state.marketplace.listings.find((l) => l.id === 'listing-2')
    expect(cleared.imageUrl).toBeNull()
    expect(cleared.images).toEqual([])
    await expect(card(page, 'listing-2').locator('[data-listing-image]')).toHaveAttribute('data-listing-image', 'placeholder')
  })

  test('image links make an ordered gallery, and Free is a price choice', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/marketplace')
    await page.getByRole('button', { name: 'Post a listing' }).click()
    await page.getByLabel('Title').fill('Bike lock')
    await page.getByLabel('Pricing').selectOption('free')
    await expect(page.locator('[data-price-hint]')).toHaveText('Listed as Free.')
    await page.getByLabel('Image links').fill('https://example.test/lock.jpg\nhttps://example.test/lock-2.jpg')
    await expect(photoMessage(page)).toContainText('2 photos from links')
    await page.getByRole('button', { name: 'Post listing' }).click()
    await expect(page.locator('[data-listing-form]')).toHaveCount(0)

    const created = mockApi.state.marketplace.listings[0]
    expect(created.title).toBe('Bike lock')
    expect(created.images).toEqual(['https://example.test/lock.jpg', 'https://example.test/lock-2.jpg'])
    expect(created.imageUrl).toBe('https://example.test/lock.jpg')
    expect(created.priceMode).toBe('free')
    expect(created.priceCents).toBe(0)
    const body = mockApi.state.marketplace.bodies.at(-1).body
    expect(body).toMatchObject({ priceMode: 'free', priceCents: 0, photos: [{ url: 'https://example.test/lock.jpg' }, { url: 'https://example.test/lock-2.jpg' }] })
    await expect(card(page, created.id)).toContainText('Free')

    // Best offer shows as such on the card and in the detail.
    await card(page, created.id).getByRole('button').first().click()
    await expect(page.locator(`[data-listing-detail="${created.id}"] [data-listing-gallery]`)).toHaveAttribute('data-listing-gallery', '2')
    await expect(page.getByAltText('Bike lock photo 2')).toHaveAttribute('src', 'https://example.test/lock-2.jpg')
  })

  test('Best offer posts a null price and reads as Best offer', async ({ page, mockApi }) => {
    mockApi.login()
    await page.goto('/marketplace')
    await page.getByRole('button', { name: 'Post a listing' }).click()
    await page.getByLabel('Title').fill('Textbook bundle')
    await page.getByLabel('Pricing').selectOption('best_offer')
    await expect(page.locator('[data-price-hint]')).toHaveText('Buyers will send offers.')
    await page.getByRole('button', { name: 'Post listing' }).click()
    await expect(page.locator('[data-listing-form]')).toHaveCount(0)
    const created = mockApi.state.marketplace.listings[0]
    expect(created.priceMode).toBe('best_offer')
    expect(created.priceCents).toBeNull()
    await expect(card(page, created.id)).toContainText('Best offer')
  })

  test('when photo storage is off the server message shows and the draft survives', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.seedMarketplace({ photosUnavailable: true })
    await page.goto('/marketplace')
    await page.getByRole('button', { name: 'Post a listing' }).click()
    await page.getByLabel('Title').fill('Mini fridge')

    await page.getByLabel('Listing photo').setInputFiles(await jpegFixture(page))
    await expect(photoStatus(page)).toHaveAttribute('data-photo-status', 'error')
    await expect(photoMessage(page)).toHaveText('Photo storage settings need attention. Please try again later.')
    await expect(page.getByLabel('Title')).toHaveValue('Mini fridge')

    // Posting is held until the photo is retried or removed.
    await page.getByRole('button', { name: 'Post listing' }).click()
    await expect(page.locator('[data-form-error]')).toContainText('Retry the photo upload or remove the photo')

    await page.getByRole('button', { name: 'Remove' }).click()
    await page.getByLabel('Image links').fill('https://example.test/fridge.jpg')
    await page.getByRole('button', { name: 'Post listing' }).click()
    await expect(page.locator('[data-listing-form]')).toHaveCount(0)
    expect(mockApi.state.marketplace.listings[0].imageUrl).toBe('https://example.test/fridge.jpg')
    expect(mockApi.state.marketplace.bodies.at(-1).body.photos).toEqual([{ url: 'https://example.test/fridge.jpg' }])
  })

  test('a failed upload keeps the photo and offers a retry', async ({ page, mockApi }) => {
    mockApi.login()
    mockApi.failNextPhotoUpload()
    await page.goto('/marketplace')
    await page.getByRole('button', { name: 'Post a listing' }).click()

    await page.getByLabel('Listing photo').setInputFiles(await jpegFixture(page))
    await expect(photoStatus(page)).toHaveAttribute('data-photo-status', 'error')
    await expect(photoMessage(page)).toHaveText('The photo upload did not finish. Check your connection and retry.')
    await expect(page.locator('[data-photo-preview]')).toBeVisible()

    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(photoStatus(page)).toHaveAttribute('data-photo-status', 'ready')
    expect(mockApi.state.marketplace.uploads.size).toBe(1)
  })

  test('sample data stays in the app shape', () => {
    const listings = sampleListings()
    expect(listings.map((l) => l.id)).toEqual(['listing-1', 'listing-2', 'listing-3'])
    expect(listings.filter((l) => l.isMine)).toHaveLength(1)
  })
})
