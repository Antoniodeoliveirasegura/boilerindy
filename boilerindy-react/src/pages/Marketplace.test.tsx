import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Marketplace from './Marketplace'
import { authRequest } from '../lib/authApi'

// Galleries and pricing choices (#177) on the website: cards and the detail
// gallery read `images` / `priceMode`, and the compose form sends the
// structured `photos` list and `priceMode` the API expects. Mark sold, delete
// and report (#224) show a failure in the page banner and never open a
// browser dialog.

const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { storage: { from: () => ({}) } } }))
vi.mock('../hooks/useConfirm', () => ({ useConfirm: () => ({ confirm: confirmMock, confirmDialog: null }) }))

const free = { id: 'free', title: 'Chair', priceCents: 0, images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] }
const REPORT_REASONS = 'Why are you reporting this listing?'

beforeEach(() => {
  confirmMock.mockReset().mockResolvedValue(true)
  vi.spyOn(window, 'alert').mockImplementation(() => {})
  vi.spyOn(window, 'prompt').mockImplementation(() => null)
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === '/api/marketplace/capabilities') return { gallery: true, pricing: true }
      if (path === '/api/marketplace/free') return { listing: free }
      return {
        listings: [free, { id: 'offer', title: 'Desk', priceMode: 'best_offer', priceCents: null }, { id: 'unknown', title: 'Lamp', priceCents: null }],
        canPost: true,
        hasMore: false,
      }
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The default API, except that `method failing` rejects the way a failed request does. */
function failRequest(method: string, failing: string) {
  const answer = vi.mocked(authRequest).getMockImplementation()
  vi.mocked(authRequest).mockImplementation(async (path, options) => {
    if (path === failing && options?.method === method) throw new Error('boom')
    return answer?.(path, options)
  })
}

function requestsTo(path: string) {
  return vi.mocked(authRequest).mock.calls.filter(([p]) => p === path)
}

function expectNoBrowserDialogs() {
  expect(window.alert).not.toHaveBeenCalled()
  expect(window.prompt).not.toHaveBeenCalled()
}

async function myListing(title: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'My listings' }))
  return within((await screen.findByText(title)).closest('article') as HTMLElement)
}

async function openReport() {
  render(<Marketplace />)
  fireEvent.click(await screen.findByText('Chair'))
  fireEvent.click(await screen.findByRole('button', { name: 'Report listing' }))
  return within(screen.getByRole('group', { name: REPORT_REASONS }))
}

it('distinguishes Free, Best offer and unspecified prices and displays the entire gallery', async () => {
  render(<Marketplace />)
  expect(await screen.findByText('Free')).toBeInTheDocument()
  expect(screen.getByText('Best offer')).toBeInTheDocument()
  expect(screen.getByText('Contact for price')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Chair'))
  expect(await screen.findByAltText('Chair photo 1')).toHaveAttribute('src', free.images[0])
  expect(screen.getByAltText('Chair photo 2')).toHaveAttribute('src', free.images[1])
})

it('posts a structured best offer and ordered image links', async () => {
  render(<Marketplace />)
  fireEvent.click(await screen.findByText('Post a listing'))
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Desk' } })
  fireEvent.change(screen.getByLabelText('Pricing'), { target: { value: 'best_offer' } })
  fireEvent.change(screen.getByLabelText('Image links'), { target: { value: free.images.join('\n') } })
  fireEvent.click(screen.getByText('Post listing'))
  await waitFor(() => expect(authRequest).toHaveBeenCalledWith('/api/marketplace', expect.objectContaining({ method: 'POST' })))
  const options = vi.mocked(authRequest).mock.calls.find(([path, options]) => path === '/api/marketplace' && options?.method === 'POST')?.[1]
  expect(JSON.parse(String(options?.body))).toMatchObject({ priceMode: 'best_offer', priceCents: null, photos: free.images.map((url) => ({ url })) })
})

it('confirms before marking a listing sold, then refetches the lists', async () => {
  render(<Marketplace />)
  const chair = await myListing('Chair')
  fireEvent.click(chair.getByRole('button', { name: 'Mark sold' }))
  await waitFor(() => expect(authRequest).toHaveBeenCalledWith('/api/marketplace?'))
  expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mark "Chair" as sold?', confirmLabel: 'Mark sold' }))
  const patch = requestsTo('/api/marketplace/free').find(([, options]) => options?.method === 'PATCH')?.[1]
  expect(JSON.parse(String(patch?.body))).toEqual({ status: 'sold' })
})

it('shows the server message when marking a listing sold fails, without refetching', async () => {
  failRequest('PATCH', '/api/marketplace/free')
  render(<Marketplace />)
  const chair = await myListing('Chair')
  fireEvent.click(chair.getByRole('button', { name: 'Mark sold' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  expect(requestsTo('/api/marketplace?')).toHaveLength(0)
  expectNoBrowserDialogs()
})

it('puts a listing back and shows the server message when deleting it fails', async () => {
  failRequest('DELETE', '/api/marketplace/free')
  render(<Marketplace />)
  const chair = await myListing('Chair')
  fireEvent.click(chair.getByRole('button', { name: 'Delete' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  expect(screen.getByText('Chair')).toBeInTheDocument()
  expect(requestsTo('/api/marketplace?')).toHaveLength(0)
  expectNoBrowserDialogs()
})

it('reports with a chosen reason and confirms inline', async () => {
  const reasons = await openReport()
  const submit = screen.getByRole('button', { name: 'Submit report' })
  expect(submit).toBeDisabled()
  expect(screen.queryByLabelText('Tell us more (optional)')).not.toBeInTheDocument()
  fireEvent.click(reasons.getByLabelText('Something else'))
  const details = screen.getByLabelText('Tell us more (optional)')
  expect(details).toHaveAttribute('maxlength', '500')
  fireEvent.change(details, { target: { value: 'Asks for a deposit first' } })
  fireEvent.click(submit)
  expect(await screen.findByText('Thanks, our team will review it.')).toHaveAttribute('role', 'status')
  const [, options] = requestsTo('/api/marketplace/free/report')[0]
  expect(options?.method).toBe('POST')
  expect(JSON.parse(String(options?.body))).toEqual({ reason: 'other: Asks for a deposit first' })
  expect(screen.queryByRole('group', { name: REPORT_REASONS })).not.toBeInTheDocument()
  expectNoBrowserDialogs()
})

it('keeps the report form and shows the server message when a report fails', async () => {
  failRequest('POST', '/api/marketplace/free/report')
  const reasons = await openReport()
  fireEvent.click(reasons.getByLabelText('Scam or fraud'))
  fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  expect(JSON.parse(String(requestsTo('/api/marketplace/free/report')[0][1]?.body))).toEqual({ reason: 'scam' })
  expect(screen.queryByText('Thanks, our team will review it.')).not.toBeInTheDocument()
  expect(reasons.getByLabelText('Scam or fraud')).toBeChecked()
  expectNoBrowserDialogs()
})
