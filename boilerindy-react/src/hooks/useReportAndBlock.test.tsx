import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { authRequest } from '../lib/authApi'
import { BLOCKED_MESSAGE, REPORT_SENT_MESSAGE, useReportAndBlock } from './useReportAndBlock'

// Issue #192: the Report and Block actions every student page shares. A block
// asks first, goes to the right route, refreshes the per-user queries (the
// Settings list) and tells the page whether to reload; a report opens the
// dialog and ends in a passing "Thanks" line.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))

let client: QueryClient
const outcomes: boolean[] = []

function Harness() {
  const { report, blockAuthor, blockUser, moderationUi } = useReportAndBlock()
  return (
    <div>
      <button type="button" onClick={() => report({ targetType: 'guide', targetId: 'rec-1', targetLabel: 'this recommendation' })}>
        Report
      </button>
      <button type="button" onClick={async () => outcomes.push(await blockAuthor('board_reply', 'reply 1'))}>
        Block author
      </button>
      <button type="button" onClick={async () => outcomes.push(await blockUser('user-9', 'Riley'))}>
        Block Riley
      </button>
      {moderationUi}
    </div>
  )
}

function renderHarness() {
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
}

function refusal(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

beforeEach(() => {
  outcomes.length = 0
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['me', 'u1', 'blocks'], [])
  vi.mocked(authRequest).mockReset().mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useReportAndBlock', () => {
  it('blocks the author by the content after the prompt, and refreshes the blocked list', async () => {
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Block author' }))
    const dialog = await screen.findByRole('dialog', { name: 'Block this author?' })
    expect(dialog).toHaveTextContent("You will no longer see each other's posts.")
    expect(authRequest).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }))
    await waitFor(() => expect(outcomes).toEqual([true]))
    expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/content/board_reply/reply%201', { method: 'POST' })
    expect(client.getQueryState(['me', 'u1', 'blocks'])?.isInvalidated).toBe(true)
    expect(await screen.findByRole('status')).toHaveTextContent(BLOCKED_MESSAGE)
  })

  it('sends nothing when the prompt is cancelled', async () => {
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Block author' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(outcomes).toEqual([false]))
    expect(authRequest).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('blocks a person by id, naming them in the prompt', async () => {
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Block Riley' }))
    const dialog = await screen.findByRole('dialog', { name: 'Block Riley?' })
    expect(dialog).toHaveTextContent('any connection or request between you ends')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }))
    await waitFor(() => expect(outcomes).toEqual([true]))
    expect(authRequest).toHaveBeenCalledWith('/api/me/blocks/user-9', { method: 'POST' })
  })

  it('shows the server message when a block is refused, and does not ask for a reload', async () => {
    vi.mocked(authRequest).mockRejectedValue(refusal(400, 'Anonymous posts cannot be blocked. Report it instead.'))
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Block author' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Block' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Anonymous posts cannot be blocked. Report it instead.')
    expect(outcomes).toEqual([false])
    expect(client.getQueryState(['me', 'u1', 'blocks'])?.isInvalidated).toBe(false)
  })

  it('falls back to a generic line when the block got no answer', async () => {
    vi.mocked(authRequest).mockRejectedValue(new Error('Failed to fetch'))
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Block author' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Block' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not block this author. Please try again.')
  })

  it('reports through the dialog and thanks the student for a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderHarness()
    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(screen.getByRole('dialog', { name: 'Report this recommendation' })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    expect(await screen.findByRole('status')).toHaveTextContent(REPORT_SENT_MESSAGE)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(JSON.parse(String(vi.mocked(authRequest).mock.calls[0][1]?.body))).toMatchObject({ targetType: 'guide', targetId: 'rec-1' })

    // Let the effect that arms the dismiss timer run before moving the clock.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(screen.getByRole('status')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
