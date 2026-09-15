import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AdminDeleted from './AdminDeleted'
import { getLiveContent, listDeletedItems, takeDownContent } from '../../lib/adminApi'

// Live-content takedown (#195): an admin pastes an id, previews the live row,
// confirms, and the item is soft-deleted through its type's DELETE route, then
// appears in the deleted list for that type.

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }))

vi.mock('../../lib/adminApi', () => ({
  listDeletedItems: vi.fn(),
  restoreDeletedItem: vi.fn(),
  hardDeleteItem: vi.fn(),
  getLiveContent: vi.fn(),
  takeDownContent: vi.fn(),
}))
vi.mock('../../hooks/useConfirm', () => ({ useConfirm: () => ({ confirm, confirmDialog: null }) }))

const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const group = {
  id: GROUP_ID,
  title: 'CS 18000 exam cram',
  description: 'Nightly in the library',
  creator_id: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-09-10T15:00:00.000Z',
  deleted_at: null,
}

let takenDown = false

beforeEach(() => {
  takenDown = false
  confirm.mockReset().mockResolvedValue(true)
  vi.mocked(listDeletedItems)
    .mockReset()
    .mockImplementation(async (type) => ({
      items: type === 'study-groups' && takenDown ? [{ ...group, deleted_at: '2026-09-16T12:00:00.000Z' }] : [],
    }))
  vi.mocked(getLiveContent).mockReset().mockResolvedValue({ item: group, label: 'Study group' })
  vi.mocked(takeDownContent)
    .mockReset()
    .mockImplementation(async () => {
      takenDown = true
      return ''
    })
})

async function findGroup() {
  render(<AdminDeleted />)
  await waitFor(() => expect(listDeletedItems).toHaveBeenCalledWith('board'))
  fireEvent.change(screen.getByLabelText('Content type'), { target: { value: 'study-groups' } })
  fireEvent.change(screen.getByLabelText('Content id'), { target: { value: `  ${GROUP_ID}  ` } })
  fireEvent.click(screen.getByRole('button', { name: 'Find' }))
}

it('previews a live item by id, takes it down, and shows it in the deleted list', async () => {
  await findGroup()
  expect(await screen.findByText('CS 18000 exam cram')).toBeInTheDocument()
  expect(getLiveContent).toHaveBeenCalledWith('study-groups', GROUP_ID)
  expect(screen.getByText(/by user 11111111-1111-4111-8111-111111111111/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Take down' }))

  await waitFor(() => expect(takeDownContent).toHaveBeenCalledWith('study-groups', GROUP_ID))
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger', confirmLabel: 'Take down' }))
  expect(await screen.findByText('Study group taken down - it now appears in the deleted list.')).toBeInTheDocument()
  expect(listDeletedItems).toHaveBeenLastCalledWith('study-groups')
  expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  expect(screen.getByText('CS 18000 exam cram')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Take down' })).not.toBeInTheDocument()
})

it('takes nothing down when the admin cancels the confirmation', async () => {
  confirm.mockResolvedValue(false)
  await findGroup()
  fireEvent.click(await screen.findByRole('button', { name: 'Take down' }))
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  expect(takeDownContent).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Take down' })).toBeInTheDocument()
})

it('shows the lookup error and offers no takedown when the id matches no live item', async () => {
  vi.mocked(getLiveContent).mockRejectedValue(new Error('Item not found.'))
  await findGroup()
  expect(await screen.findByRole('alert')).toHaveTextContent('Item not found.')
  expect(screen.queryByRole('button', { name: 'Take down' })).not.toBeInTheDocument()
  expect(takeDownContent).not.toHaveBeenCalled()
})
