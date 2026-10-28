import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AdminCampaigns from './AdminCampaigns'
import { listAdminCampaigns, updateAdminCampaign } from '../../lib/adminApi'

// Campaign review bugs in the admin console:
// - A slow answer for one filter landed after the admin picked another and
//   replaced its rows, so pending campaigns showed under the Live pill.
// - The confirm dialogs reused the target status's badge ('Live campaign
//   "X"?' with a button named Live), and End, which cannot be undone, was
//   not styled as destructive.
// - After approving through the dialog, focus fell to <body>.
// - Photo links had no name, and the active filter pill no pressed state.

vi.mock('../../lib/adminApi', () => ({
  listAdminCampaigns: vi.fn(),
  updateAdminCampaign: vi.fn(),
}))

type Campaign = { id: string; name: string; status: string; placement: string; creative?: Record<string, unknown> }

const PENDING: Campaign = {
  id: 'cmp-pending',
  name: 'Finals coffee',
  status: 'pending_review',
  placement: 'side-rail',
  creative: {
    ctaUrl: 'https://cafe.example/',
    imageUrls: ['https://img.example/1.jpg', 'https://img.example/2.jpg', 'https://img.example/3.jpg'],
  },
}
const LIVE: Campaign = { id: 'cmp-live', name: 'Bagel Tuesday', status: 'active', placement: 'dining' }

beforeEach(() => {
  vi.mocked(listAdminCampaigns)
    .mockReset()
    .mockImplementation(async (status) => ({ campaigns: status === 'active' ? [LIVE] : [PENDING] }))
  vi.mocked(updateAdminCampaign)
    .mockReset()
    .mockImplementation(async (id, { status }) => ({ campaign: { ...(id === LIVE.id ? LIVE : PENDING), status } }))
})

afterEach(cleanup)

function cardOf(name: string): HTMLElement {
  return screen.getByRole('heading', { name, level: 2 }).closest('article') as HTMLElement
}

describe('AdminCampaigns filters', () => {
  it('drops a slow answer for a filter the admin has already left', async () => {
    let resolvePending!: (value: unknown) => void
    vi.mocked(listAdminCampaigns).mockImplementation(async (status) => {
      if (status === 'pending_review') {
        return new Promise((resolve) => {
          resolvePending = resolve
        })
      }
      return { campaigns: [LIVE] }
    })
    render(<AdminCampaigns />)
    await waitFor(() => expect(listAdminCampaigns).toHaveBeenCalledWith('pending_review'))

    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(await screen.findByText('Bagel Tuesday')).toBeInTheDocument()
    await act(async () => {
      resolvePending({ campaigns: [PENDING] })
    })

    expect(screen.queryByText('Finals coffee')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve & go live' })).not.toBeInTheDocument()
    expect(screen.getByText('Bagel Tuesday')).toBeInTheDocument()
    expect(screen.queryByText('Loading campaigns…')).not.toBeInTheDocument()
  })

  it('marks the active filter pill as pressed', async () => {
    render(<AdminCampaigns />)
    await screen.findByText('Finals coffee')
    const group = screen.getByRole('group', { name: 'Campaign status' })
    expect(within(group).getByRole('button', { name: 'Pending review' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('names each photo link after the campaign', async () => {
    render(<AdminCampaigns />)
    await screen.findByText('Finals coffee')
    for (const n of [1, 2, 3]) {
      expect(screen.getByRole('link', { name: `Finals coffee, ${n} of 3` })).toHaveAttribute(
        'href',
        `https://img.example/${n}.jpg`,
      )
    }
  })
})

describe('AdminCampaigns confirm dialogs', () => {
  it('asks to approve with the button the admin pressed', async () => {
    render(<AdminCampaigns />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve & go live' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Approve "Finals coffee"?')
    expect(within(dialog).getByRole('button', { name: 'Approve & go live' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('asks to send back, and End warns that it cannot be undone in a destructive dialog', async () => {
    render(<AdminCampaigns />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send back' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Send back "Finals coffee"?')
    expect(within(dialog).getByRole('button', { name: 'Send back' })).toHaveClass('btn-primary')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'End' }))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('heading')).toHaveTextContent('End "Finals coffee"?')
    expect(within(dialog).getByText('An ended campaign cannot be resumed.')).toBeInTheDocument()
    const end = within(dialog).getByRole('button', { name: 'End' })
    expect(end).not.toHaveClass('btn-primary')
    expect(end.className).toContain('color-error')
  })

  it('asks to pause and resume a live or paused campaign by those names', async () => {
    vi.mocked(listAdminCampaigns).mockResolvedValue({ campaigns: [LIVE, { ...LIVE, id: 'cmp-paused', name: 'Taco night', status: 'paused' }] })
    render(<AdminCampaigns />)
    fireEvent.click(within(await waitFor(() => cardOf('Bagel Tuesday'))).getByRole('button', { name: 'Pause' }))
    expect(within(await screen.findByRole('dialog')).getByRole('heading')).toHaveTextContent('Pause "Bagel Tuesday"?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(within(cardOf('Taco night')).getByRole('button', { name: 'Resume' }))
    expect(within(await screen.findByRole('dialog')).getByRole('heading')).toHaveTextContent('Resume "Taco night"?')
  })
})

describe('AdminCampaigns focus', () => {
  it('puts focus on the campaign card after an approval removes the Approve button', async () => {
    render(<AdminCampaigns />)
    const approve = await screen.findByRole('button', { name: 'Approve & go live' })
    approve.focus()
    fireEvent.click(approve)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve & go live' }))

    await waitFor(() => expect(updateAdminCampaign).toHaveBeenCalledWith(PENDING.id, { status: 'active' }))
    await waitFor(() => expect(cardOf('Finals coffee')).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Approve & go live' })).not.toBeInTheDocument()
  })
})
