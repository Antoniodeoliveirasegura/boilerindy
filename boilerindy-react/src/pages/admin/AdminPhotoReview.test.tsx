import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdminPhotoReview from './AdminPhotoReview'
import { decideListingPhotos, listPhotoReview, type PhotoReviewListing } from '../../lib/adminApi'

// The photo queue (#504): an admin sees each listing whose photos wait, with
// every photo, and approves them or rejects them (after confirming). A
// decision carries the version the queue showed; a listing the seller edited
// since answers 409 and the queue is read again.

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))

vi.mock('../../lib/adminApi', () => ({
  listPhotoReview: vi.fn(),
  decideListingPhotos: vi.fn(),
}))
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => ({ confirm, confirmDialog: null }) }))

const FRIDGE_ID = '55555555-5555-4555-8555-555555555555'
const LAMP_ID = '56565656-5656-4565-8565-565656565656'

function listing(overrides: Partial<PhotoReviewListing> = {}): PhotoReviewListing {
  return {
    id: FRIDGE_ID,
    title: 'Mini fridge',
    description: 'Works, a little loud',
    category: 'furniture',
    status: 'active',
    hidden: false,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    images: ['https://cdn.example/fridge-1.jpg', 'https://cdn.example/fridge-2.jpg'],
    seller: { id: 'seller-1', displayName: 'Blake' },
    ...overrides,
  }
}

const QUEUE = [
  listing(),
  listing({
    id: LAMP_ID,
    title: 'Desk lamp',
    description: '',
    category: 'electronics',
    status: 'sold',
    hidden: true,
    updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    images: ['https://example.com/lamp.jpg'],
    seller: { id: 'seller-2', displayName: null },
  }),
]

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  vi.mocked(listPhotoReview).mockReset().mockResolvedValue({ listings: QUEUE })
  vi.mocked(decideListingPhotos).mockReset().mockResolvedValue({ ok: true })
})

function rowFor(title: string) {
  return screen.getByText(title).closest('li') as HTMLElement
}

it('lists each waiting listing with its photos, its seller and how long it has waited', async () => {
  render(<AdminPhotoReview />)
  expect(await screen.findByText('Mini fridge')).toBeInTheDocument()
  const fridge = within(rowFor('Mini fridge'))
  expect(fridge.getByText('Furniture')).toBeInTheDocument()
  expect(fridge.getByText('Posted by Blake')).toBeInTheDocument()
  expect(fridge.getByText('Works, a little loud')).toBeInTheDocument()
  expect(fridge.getByText(/Waiting since .* \(2 h ago\)/)).toBeInTheDocument()
  // Every photo, each opening at full size.
  const photos = within(fridge.getByRole('group', { name: 'Photos of Mini fridge' }))
  expect(photos.getByAltText('Mini fridge photo 1')).toHaveAttribute('src', 'https://cdn.example/fridge-1.jpg')
  expect(photos.getByAltText('Mini fridge photo 2')).toHaveAttribute('src', 'https://cdn.example/fridge-2.jpg')
  expect(photos.getAllByRole('link')[0]).toHaveAttribute('href', 'https://cdn.example/fridge-1.jpg')

  const lamp = within(rowFor('Desk lamp'))
  expect(lamp.getByText('Sold')).toBeInTheDocument()
  expect(lamp.getByText('Hidden by reports')).toBeInTheDocument()
  expect(lamp.getByText('Posted by a student with no name')).toBeInTheDocument()
  // Waiting longer than a day is marked, like an overdue report.
  expect(lamp.getByText(/Waiting since .* \(1 day ago\)/)).toHaveClass('font-semibold')
  expect(fridge.getByText(/Waiting since/)).not.toHaveClass('font-semibold')
})

it('approves the photos with the version the queue showed and takes the listing off the queue', async () => {
  render(<AdminPhotoReview />)
  await screen.findByText('Mini fridge')
  fireEvent.click(within(rowFor('Mini fridge')).getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(screen.queryByText('Mini fridge')).not.toBeInTheDocument())
  expect(decideListingPhotos).toHaveBeenCalledWith(FRIDGE_ID, 'approve', QUEUE[0].updatedAt)
  expect(confirm).not.toHaveBeenCalled()
  expect(screen.getByText('Photos approved. Every student can see them now.')).toBeInTheDocument()
  expect(screen.getByText('Desk lamp')).toBeInTheDocument()
})

it('rejects only after the admin confirms', async () => {
  render(<AdminPhotoReview />)
  await screen.findByText('Mini fridge')

  confirm.mockResolvedValueOnce(false)
  fireEvent.click(within(rowFor('Desk lamp')).getByRole('button', { name: 'Reject' }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reject these photos?', confirmLabel: 'Reject photos', tone: 'danger' }))
  expect(decideListingPhotos).not.toHaveBeenCalled()

  fireEvent.click(within(rowFor('Desk lamp')).getByRole('button', { name: 'Reject' }))
  await waitFor(() => expect(screen.queryByText('Desk lamp')).not.toBeInTheDocument())
  expect(decideListingPhotos).toHaveBeenCalledWith(LAMP_ID, 'reject', QUEUE[1].updatedAt)
  expect(screen.getByText('Photos rejected and removed from the listing.')).toBeInTheDocument()
})

it('reads the queue again when the seller changed the listing since it loaded', async () => {
  const edited = listing({ updatedAt: new Date().toISOString(), images: ['https://cdn.example/fridge-3.jpg'] })
  vi.mocked(listPhotoReview).mockResolvedValueOnce({ listings: QUEUE }).mockResolvedValueOnce({ listings: [edited] })
  vi.mocked(decideListingPhotos).mockRejectedValueOnce(
    Object.assign(new Error('The seller changed this listing after the queue loaded. Reload to see the latest photos.'), { status: 409 }),
  )
  render(<AdminPhotoReview />)
  await screen.findByText('Mini fridge')
  fireEvent.click(within(rowFor('Mini fridge')).getByRole('button', { name: 'Approve' }))
  expect(await screen.findByText('The seller changed this listing after the queue loaded. Reload to see the latest photos.')).toBeInTheDocument()
  // The new photo is what the admin now sees.
  await waitFor(() => expect(screen.getByAltText('Mini fridge photo 1')).toHaveAttribute('src', 'https://cdn.example/fridge-3.jpg'))
  expect(listPhotoReview).toHaveBeenCalledTimes(2)
  expect(screen.getByText('The seller changed this listing after the queue loaded. Reload to see the latest photos.')).toBeInTheDocument()
  expect(screen.queryByText('Desk lamp')).not.toBeInTheDocument()
})

it('says when nothing waits, and shows the server message when the queue cannot load', async () => {
  vi.mocked(listPhotoReview).mockResolvedValueOnce({ listings: [] })
  const { unmount } = render(<AdminPhotoReview />)
  expect(await screen.findByText('Nothing to review')).toBeInTheDocument()
  unmount()

  vi.mocked(listPhotoReview).mockRejectedValueOnce(new Error('Photo review is not set up yet. Please try again later.'))
  render(<AdminPhotoReview />)
  expect(await screen.findByText('Photo review is not set up yet. Please try again later.')).toBeInTheDocument()
  expect(screen.getByText('Nothing to review')).toBeInTheDocument()
})
