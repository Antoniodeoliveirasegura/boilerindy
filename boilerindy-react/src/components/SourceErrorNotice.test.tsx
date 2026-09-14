import { afterEach, describe, expect, test, vi, type Mock } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SourceErrorNotice from './SourceErrorNotice'
import { authRequest } from '../lib/authApi'

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
const mockedRequest = authRequest as unknown as Mock

// Issue #12 - an expired feed must be visible on the pages students use, not
// only as a badge on the Connect page.

afterEach(() => {
  cleanup()
  mockedRequest.mockReset()
})

function renderNotice() {
  return render(
    <MemoryRouter>
      <SourceErrorNotice />
    </MemoryRouter>,
  )
}

describe('SourceErrorNotice', () => {
  test('names each broken source, repeats the sync error, and links back to setup', async () => {
    mockedRequest.mockResolvedValue({
      sources: [
        { id: 'ok', label: 'Class Schedule', status: 'ready', lastError: null },
        {
          id: 'bad',
          label: 'Brightspace Calendar',
          status: 'error',
          lastError: 'Calendar access denied. The feed URL may have expired - try generating a new one.',
        },
      ],
    })
    renderNotice()

    const notice = await screen.findByTestId('source-error-notice')
    expect(notice).toHaveTextContent('Brightspace Calendar stopped syncing: Calendar access denied.')
    expect(notice).not.toHaveTextContent('Class Schedule')
    expect(screen.getByRole('link', { name: /reconnect it in calendar sources/i })).toHaveAttribute('href', '/setup')
    expect(mockedRequest).toHaveBeenCalledWith('/api/me/sources')
  })

  test('renders nothing when every source is healthy or the request fails', async () => {
    mockedRequest.mockResolvedValue({ sources: [{ id: 'ok', label: 'Class Schedule', status: 'ready' }] })
    renderNotice()
    await waitFor(() => expect(mockedRequest).toHaveBeenCalled())
    expect(screen.queryByTestId('source-error-notice')).toBeNull()

    cleanup()
    mockedRequest.mockRejectedValue(new Error('offline'))
    renderNotice()
    await waitFor(() => expect(mockedRequest).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('source-error-notice')).toBeNull()
  })
})
