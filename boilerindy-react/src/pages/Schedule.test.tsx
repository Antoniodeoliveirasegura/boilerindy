import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Schedule from './Schedule'

// Issue #372: with PURDUE_AUTH_MODE=off, needsPurdueConnection is always false,
// and the setup card read that as "linked", telling students who never linked
// Purdue that their Purdue account was linked. The card now says so only when
// the account really has a Purdue link.

// One stable result: a new object per render would loop the page's derived state.
const classes = vi.hoisted(() => ({ data: { items: [] as unknown[] }, isLoading: false, error: null }))
vi.mock('../lib/queries/userData', () => ({ useMyClasses: () => classes }))
// Saved overrides are mirrored to the server after a debounce.
vi.mock('../lib/authApi', () => ({ authRequest: vi.fn(async () => ({})) }))
const auth = vi.hoisted(() => ({
  user: { id: 'user-1' },
  onboarding: {
    linkedSourceCount: 0,
    classCount: 0,
    hasPurdueLinked: false,
    needsPurdueConnection: false,
    needsScheduleSource: true,
  },
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))

afterEach(() => {
  cleanup()
  classes.data = { items: [] }
  localStorage.clear()
})

function renderWith(onboarding: Partial<typeof auth.onboarding>) {
  auth.onboarding = { ...auth.onboarding, ...onboarding }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Schedule />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Schedule setup card', () => {
  test('linking off and never linked: asks for the timetable feed and claims no link', () => {
    renderWith({ hasPurdueLinked: false, needsPurdueConnection: false, needsScheduleSource: true })
    expect(screen.getByText('Connect your timetable feed to sync your recurring class meetings into this page.')).toBeInTheDocument()
    expect(screen.queryByText(/Purdue account is linked/)).toBeNull()
  })

  test('linking on and not linked: asks to link Purdue first', () => {
    renderWith({ hasPurdueLinked: false, needsPurdueConnection: true, needsScheduleSource: false })
    expect(screen.getByText('Link Purdue to import your schedule')).toBeInTheDocument()
    expect(screen.queryByText(/Purdue account is linked/)).toBeNull()
  })

  test('linked with no feed yet: says the Purdue account is linked', () => {
    renderWith({ hasPurdueLinked: true, needsPurdueConnection: false, needsScheduleSource: true })
    expect(screen.getByText(/Your Purdue account is linked\./)).toBeInTheDocument()
  })
})

// A local time on a fixed week: Monday 2026-10-12 to Friday 2026-10-16.
function at(day: number, hm: string) {
  const [h, m] = hm.split(':').map(Number)
  return new Date(2026, 9, 12 + day, h, m).toISOString()
}

function meeting(title: string, description: string, location: string, day: number, start: string, end: string) {
  return { title, description, location, startTime: at(day, start), endTime: at(day, end) }
}

const OVERRIDES_KEY = 'boilerindy-schedule-overrides-v1-user-1'

function savedSeries() {
  return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}').series || {}
}

// The weekday tabs read "Monday" with a "Mon" twin for phones.
function dayTab(day: string) {
  return screen.getAllByRole('button').find((b) => b.textContent?.startsWith(day)) as HTMLElement
}

function editor() {
  return screen.getByRole('heading', { name: 'Edit class' }).closest('section') as HTMLElement
}

function renderClasses(items: unknown[]) {
  classes.data = { items }
  renderWith({ hasPurdueLinked: true, needsPurdueConnection: false, needsScheduleSource: false })
}

describe('Schedule editor', () => {
  // PHYS 17200 meets Monday 9:30 and Wednesday 2:30, one series.
  const phys = [
    meeting('PHYS 17200 Modern Mechanics', 'Lecture', 'PHYS 112', 0, '09:30', '10:20'),
    meeting('PHYS 17200 Modern Mechanics', 'Lecture', 'PHYS 112', 2, '14:30', '15:20'),
  ]

  // R24: every save wrote the clicked meeting's times into the series-wide
  // override, so a room-only edit on Monday moved Wednesday to 9:30.
  test('a room-only edit keeps each day at its own time', () => {
    renderClasses(phys)
    fireEvent.click(dayTab('Monday'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit PHYS 17200 Modern Mechanics' }))
    fireEvent.change(within(editor()).getByLabelText('Room / location'), { target: { value: 'PHYS 114' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    const [override] = Object.values(savedSeries()) as Record<string, unknown>[]
    expect(override).toMatchObject({ room: 'PHYS 114' })
    expect(override.startHm).toBeUndefined()
    expect(override.endHm).toBeUndefined()

    fireEvent.click(dayTab('Wednesday'))
    // The row, not the side panel's copy of the name.
    const wednesday = screen.getAllByText('Lecture').map((el) => el.closest('.cursor-pointer')).find(Boolean) as HTMLElement
    expect(wednesday).toHaveTextContent('2:30')
    expect(wednesday).toHaveTextContent('PHYS 114')
  })

  test('a time edit still applies to the series', () => {
    renderClasses(phys)
    fireEvent.click(dayTab('Monday'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit PHYS 17200 Modern Mechanics' }))
    fireEvent.change(within(editor()).getByLabelText('Starts'), { target: { value: '09:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(Object.values(savedSeries())).toEqual([
      expect.objectContaining({ startHm: '09:00', endHm: '10:20' }),
    ])
  })

  // R25: Reset to imported lived only in the side panel, which is hidden
  // below lg, and that panel kept the class from before the edit, so it
  // showed no reset until the class was picked again.
  test('an edited imported class can be reset from the editor, and the panel offers it at once', () => {
    renderClasses(phys)
    fireEvent.click(dayTab('Monday'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit PHYS 17200 Modern Mechanics' }))
    expect(within(editor()).queryByRole('button', { name: 'Reset to imported' })).toBeNull()
    fireEvent.change(within(editor()).getByLabelText('Room / location'), { target: { value: 'PHYS 114' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // The editor is closed, so this is the side panel's button.
    expect(screen.getByRole('button', { name: 'Reset to imported' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit PHYS 17200 Modern Mechanics' }))
    fireEvent.click(within(editor()).getByRole('button', { name: 'Reset to imported' }))

    expect(savedSeries()).toEqual({})
    expect(screen.queryByText('Edited')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Edit class' })).toBeNull()
  })

  // R47: Meets on let an imported class turn on a weekday the feed has no
  // meeting on, which saved but could never show anything that day.
  test('Meets on offers only the days the feed has for an imported class', () => {
    renderClasses([
      meeting('CS 25100 Data Structures', 'Lecture', 'LWSN B151', 0, '10:30', '11:20'),
      meeting('CS 25100 Data Structures', 'Lecture', 'LWSN B151', 2, '10:30', '11:20'),
      meeting('CS 25100 Data Structures', 'Lecture', 'LWSN B151', 4, '10:30', '11:20'),
    ])
    fireEvent.click(dayTab('Monday'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit CS 25100 Data Structures' }))

    const pills = within(editor())
    expect(pills.getByRole('button', { name: 'Tue' })).toBeDisabled()
    expect(pills.getByRole('button', { name: 'Thu' })).toBeDisabled()
    for (const day of ['Mon', 'Wed', 'Fri']) expect(pills.getByRole('button', { name: day })).toBeEnabled()
    expect(editor()).toHaveTextContent('To add a meeting on another day, use Add class.')

    // Dropping a feed day still works, and it can be turned back on.
    fireEvent.click(pills.getByRole('button', { name: 'Fri' }))
    expect(pills.getByRole('button', { name: 'Fri' })).toBeEnabled()
    expect(pills.getByRole('button', { name: 'Fri' })).not.toHaveClass('pill-active')
  })

  test('Add class still offers every weekday', () => {
    renderClasses([])
    fireEvent.click(screen.getAllByRole('button', { name: 'Add class' })[0])
    const pills = within(screen.getByRole('heading', { name: 'Add a class' }).closest('section') as HTMLElement)
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) expect(pills.getByRole('button', { name: day })).toBeEnabled()
  })

  // R25 follow-up: the editor's Save and Reset acted on whichever class was
  // selected when pressed. A tap on another row, or a day-tab switch, changes
  // the selection while the editor stays open, so they saved over or reset the
  // other class. They now act on the class the editor was opened for.
  describe('the editor acts on the class it was opened for', () => {
    const twoOnMonday = [
      meeting('CS 25100 Data Structures', 'Lecture', 'LWSN B160', 0, '10:30', '11:20'),
      meeting('ECE 20200 Linear Circuits', 'Lecture', 'ET 202', 0, '13:30', '14:20'),
      meeting('MA 26100 Multivariate Calculus', 'Lecture', 'SL 008', 1, '09:30', '10:20'),
    ]
    const row = (text: string) =>
      screen.getAllByText(text).map((el) => el.closest('.cursor-pointer')).find(Boolean) as HTMLElement
    const editRoom = (code: string, room: string) => {
      fireEvent.click(screen.getByRole('button', { name: `Edit ${code}` }))
      fireEvent.change(within(editor()).getByLabelText('Room / location'), { target: { value: room } })
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    }
    const rooms = () => (Object.values(savedSeries()) as { room?: string }[]).map((o) => o.room).sort()

    test('Save after tapping another row saves the opened class', () => {
      renderClasses(twoOnMonday)
      fireEvent.click(dayTab('Monday'))
      fireEvent.click(screen.getByRole('button', { name: 'Edit CS 25100 Data Structures' }))
      fireEvent.change(within(editor()).getByLabelText('Room / location'), { target: { value: 'LWSN B151' } })
      fireEvent.click(row('Linear Circuits'))
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

      expect(rooms()).toEqual(['LWSN B151'])
      expect(row('Linear Circuits')).toHaveTextContent('ET 202')
      expect(row('Data Structures')).toHaveTextContent('LWSN B151')
    })

    test('Reset after tapping another row resets the opened class', () => {
      renderClasses(twoOnMonday)
      fireEvent.click(dayTab('Monday'))
      editRoom('CS 25100 Data Structures', 'LWSN B151')
      editRoom('ECE 20200 Linear Circuits', 'ET 101')
      fireEvent.click(screen.getByRole('button', { name: 'Edit CS 25100 Data Structures' }))
      fireEvent.click(row('Linear Circuits'))
      fireEvent.click(within(editor()).getByRole('button', { name: 'Reset to imported' }))

      expect(rooms()).toEqual(['ET 101'])
      expect(row('Data Structures')).toHaveTextContent('LWSN B160')
    })

    test('Reset after switching the day tab resets the opened class', () => {
      renderClasses(twoOnMonday)
      fireEvent.click(dayTab('Tuesday'))
      editRoom('MA 26100 Multivariate Calculus', 'SL 010')
      fireEvent.click(dayTab('Monday'))
      editRoom('CS 25100 Data Structures', 'LWSN B151')
      fireEvent.click(screen.getByRole('button', { name: 'Edit CS 25100 Data Structures' }))
      fireEvent.click(dayTab('Tuesday'))
      fireEvent.click(within(editor()).getByRole('button', { name: 'Reset to imported' }))

      expect(rooms()).toEqual(['SL 010'])
    })
  })
})
