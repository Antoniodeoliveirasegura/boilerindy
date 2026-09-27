import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdminReports from './AdminReports'
import {
  closeReport,
  getLiveContent,
  listReports,
  takeDownContent,
  takeDownHiddenListing,
  type ContentReport,
} from '../../lib/adminApi'

// The report queue (#192): an admin reads open reports, opens the content,
// takes it down through the type's own route, and resolves or dismisses the
// report.

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))

vi.mock('../../lib/adminApi', () => ({
  listReports: vi.fn(),
  closeReport: vi.fn(),
  getLiveContent: vi.fn(),
  takeDownContent: vi.fn(),
  takeDownHiddenListing: vi.fn(),
}))
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => ({ confirm, confirmDialog: null }) }))

const POST_ID = '44444444-4444-4444-8444-444444444444'
const LISTING_ID = '55555555-5555-4555-8555-555555555555'

function report(overrides: Partial<ContentReport> = {}): ContentReport {
  return {
    id: 'report-post',
    targetType: 'board_post',
    targetId: POST_ID,
    reason: 'harassment',
    details: 'names a classmate',
    status: 'open',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    reporter: { id: 'reporter-1', displayName: 'Riley' },
    target: { title: 'Selling my notes', authorId: 'author-1', authorName: 'Avery', deleted: false, hidden: false },
    ...overrides,
  }
}

const QUEUE: ContentReport[] = [
  report(),
  report({
    id: 'report-listing',
    targetType: 'marketplace',
    targetId: LISTING_ID,
    reason: 'scam',
    details: '',
    target: { title: 'Mini fridge', authorId: 'author-2', authorName: 'Blake', deleted: false, hidden: true },
  }),
  report({
    id: 'report-reply',
    targetType: 'board_reply',
    targetId: '66666666-6666-4666-8666-666666666666',
    reason: 'spam',
    details: '',
    target: { title: 'Buy followers at example.com', authorId: 'author-3', authorName: null, deleted: false, hidden: false },
  }),
  report({
    id: 'report-user',
    targetType: 'user',
    targetId: '77777777-7777-4777-8777-777777777777',
    reason: 'other',
    details: 'keeps messaging me',
    target: { title: 'Casey', authorId: '77777777-7777-4777-8777-777777777777', authorName: 'Casey', deleted: false, hidden: false },
  }),
]

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true)
  vi.mocked(listReports)
    .mockReset()
    .mockImplementation(async (status) => ({ reports: status === 'open' ? QUEUE : [] }))
  vi.mocked(closeReport).mockReset().mockResolvedValue({ ok: true })
  vi.mocked(getLiveContent).mockReset().mockResolvedValue({ item: { id: POST_ID, title: 'Selling my notes', body: 'DM me for the answers' } })
  vi.mocked(takeDownContent).mockReset().mockResolvedValue('')
  vi.mocked(takeDownHiddenListing).mockReset().mockResolvedValue({ ok: true })
})

function rowFor(title: string) {
  return screen.getByText(title).closest('li') as HTMLElement
}

it('lists the open reports with the type, the content, the reason and the reporter', async () => {
  render(<AdminReports />)
  expect(await screen.findByText('Selling my notes')).toBeInTheDocument()
  expect(listReports).toHaveBeenCalledWith('open')
  const post = rowFor('Selling my notes')
  expect(within(post).getByText('Board post')).toBeInTheDocument()
  expect(within(post).getByText('Harassment')).toBeInTheDocument()
  expect(within(post).getByText(': names a classmate')).toBeInTheDocument()
  expect(within(post).getByText('Posted by Avery')).toBeInTheDocument()
  expect(within(post).getByText(/Reported by Riley, 2 h ago/)).toBeInTheDocument()
  expect(within(rowFor('Mini fridge')).getByText('Hidden by reports')).toBeInTheDocument()
  // A reply shows its whole text inline; a user shows their name.
  expect(screen.getByText('Buy followers at example.com')).toBeInTheDocument()
  expect(within(rowFor('Casey')).getByText('User')).toBeInTheDocument()
})

it('switches the queue to resolved and dismissed reports', async () => {
  render(<AdminReports />)
  await screen.findByText('Selling my notes')
  fireEvent.click(screen.getByRole('button', { name: 'Resolved' }))
  expect(await screen.findByText('No resolved reports.')).toBeInTheDocument()
  expect(listReports).toHaveBeenLastCalledWith('resolved')
  fireEvent.click(screen.getByRole('button', { name: 'Dismissed' }))
  await waitFor(() => expect(listReports).toHaveBeenLastCalledWith('dismissed'))
})

it('resolve and dismiss close the report and take it off the open queue', async () => {
  render(<AdminReports />)
  await screen.findByText('Selling my notes')
  fireEvent.click(within(rowFor('Selling my notes')).getByRole('button', { name: 'Resolve' }))
  await waitFor(() => expect(screen.queryByText('Selling my notes')).not.toBeInTheDocument())
  expect(closeReport).toHaveBeenCalledWith('report-post', 'resolved')
  expect(screen.getByText('Report resolved.')).toBeInTheDocument()

  fireEvent.click(within(rowFor('Casey')).getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(screen.queryByText('Casey')).not.toBeInTheDocument())
  expect(closeReport).toHaveBeenCalledWith('report-user', 'dismissed')
})

it('takes a post down through its own route and a listing through the admin takedown, after confirming', async () => {
  render(<AdminReports />)
  await screen.findByText('Selling my notes')

  confirm.mockResolvedValueOnce(false)
  fireEvent.click(within(rowFor('Selling my notes')).getByRole('button', { name: 'Take down' }))
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
  expect(takeDownContent).not.toHaveBeenCalled()

  fireEvent.click(within(rowFor('Selling my notes')).getByRole('button', { name: 'Take down' }))
  await waitFor(() => expect(takeDownContent).toHaveBeenCalledWith('board', POST_ID))
  expect(await within(rowFor('Selling my notes')).findByText('Taken down')).toBeInTheDocument()
  expect(within(rowFor('Selling my notes')).queryByRole('button', { name: 'Take down' })).not.toBeInTheDocument()
  // Taking content down does not close the report.
  expect(within(rowFor('Selling my notes')).getByRole('button', { name: 'Resolve' })).toBeInTheDocument()

  fireEvent.click(within(rowFor('Mini fridge')).getByRole('button', { name: 'Take down' }))
  await waitFor(() => expect(takeDownHiddenListing).toHaveBeenCalledWith(LISTING_ID))
})

it('offers no open or takedown for a reply or a user', async () => {
  render(<AdminReports />)
  await screen.findByText('Selling my notes')
  for (const title of ['Buy followers at example.com', 'Casey']) {
    const row = rowFor(title)
    expect(within(row).queryByRole('button', { name: 'Take down' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Open' })).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
  }
})

it('opens the live content inline, and says so when it is gone', async () => {
  render(<AdminReports />)
  await screen.findByText('Selling my notes')
  fireEvent.click(within(rowFor('Selling my notes')).getByRole('button', { name: 'Open' }))
  expect(await screen.findByText('DM me for the answers')).toBeInTheDocument()
  expect(getLiveContent).toHaveBeenCalledWith('board', POST_ID)

  vi.mocked(getLiveContent).mockRejectedValueOnce(Object.assign(new Error('Item not found.'), { status: 404 }))
  fireEvent.click(within(rowFor('Mini fridge')).getByRole('button', { name: 'Open' }))
  expect(await screen.findByText('It is no longer live: it was taken down or deleted.')).toBeInTheDocument()
  expect(getLiveContent).toHaveBeenLastCalledWith('marketplace', LISTING_ID)
})

it('shows the server message when the queue cannot load', async () => {
  vi.mocked(listReports).mockRejectedValueOnce(new Error('Reporting content is not set up yet. Please try again later.'))
  render(<AdminReports />)
  expect(await screen.findByText('Reporting content is not set up yet. Please try again later.')).toBeInTheDocument()
  expect(screen.getByText('No open reports. New ones show up here as students file them.')).toBeInTheDocument()
})
