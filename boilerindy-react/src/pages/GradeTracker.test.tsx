import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import GradeTracker from './GradeTracker'
import { authRequest } from '../lib/authApi'

// The grade tracker page against a mocked /api/me/grades, through the real
// useGradeTracker hook. Layout (R6, the term card running off a phone screen)
// needs a real browser and is not covered here.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }))

const saved = { id: 'grade-1', courseName: 'CS 18000', term: 'Fall 2025', creditHours: 4, letterGrade: 'A' }

type Held = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

let readGrades: () => unknown
// When set, writes wait here until a test settles them.
let held: Held[] | null
// jsdom has no scrollIntoView; Edit calls it.
let scrollIntoView: Mock<Element['scrollIntoView']>

beforeEach(() => {
  localStorage.clear()
  readGrades = () => ({ grades: [saved] })
  held = null
  scrollIntoView = vi.fn<Element['scrollIntoView']>()
  Element.prototype.scrollIntoView = scrollIntoView
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path, options) => {
      if (path === '/api/me/degree') return { major: null }
      if (!options?.method) return readGrades()
      if (held) {
        const queue = held
        return new Promise((resolve, reject) => queue.push({ resolve, reject }))
      }
      if (options.method === 'POST') return { grade: { ...JSON.parse(String(options.body)), id: 'grade-2' } }
      return { ok: true }
    })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (Element.prototype as Partial<Element>).scrollIntoView
})

async function renderPage() {
  const view = render(<GradeTracker />)
  await waitFor(() => expect(screen.queryByText('Loading your courses…')).toBeNull())
  return view
}

function courseInput() {
  return screen.getByLabelText('Course', { selector: 'input' })
}

function writesWith(method: string) {
  return vi.mocked(authRequest).mock.calls.filter(([, options]) => options?.method === method)
}

describe('Grade tracker form', () => {
  // R9: submit had no guard and the button never disabled, so a double click
  // or Enter pressed twice saved the same course twice.
  test('two submits before the first save answers send one course', async () => {
    const { container } = await renderPage()
    held = []
    const writes = held
    fireEvent.change(courseInput(), { target: { value: 'MA 26100' } })
    const form = container.querySelector('form') as HTMLFormElement

    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    expect(writesWith('POST')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Add course' })).toBeDisabled()

    await act(async () => {
      writes[0].resolve({ grade: { id: 'grade-2', courseName: 'MA 26100', term: 'Fall 2025', creditHours: 3, letterGrade: 'A' } })
    })

    expect(screen.getAllByText('MA 26100')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Add course' })).toBeEnabled()
    expect(courseInput()).toHaveValue('')
  })

  // R10: an add that answered after an Edit was opened cleared the form, so
  // the edit the student had started was gone.
  test('an edit opened while an add is saving stays in the form when the add answers', async () => {
    const { container } = await renderPage()
    held = []
    const writes = held
    fireEvent.change(courseInput(), { target: { value: 'PHYS 17200' } })
    act(() => {
      fireEvent.submit(container.querySelector('form') as HTMLFormElement)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit CS 18000' }))

    await act(async () => {
      writes[0].resolve({ grade: { id: 'grade-2', courseName: 'PHYS 17200', term: 'Fall 2025', creditHours: 3, letterGrade: 'A' } })
    })

    expect(screen.getByText('Edit course')).toBeInTheDocument()
    expect(courseInput()).toHaveValue('CS 18000')
  })

  // R52 and R76: Edit scrolled the window to the top, smoothly even with
  // reduced motion on, which left the form off screen below Degree progress
  // and focus on the row.
  test('Edit brings the form into view and moves focus into it', async () => {
    const { container } = await renderPage()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    fireEvent.click(screen.getByRole('button', { name: 'Edit CS 18000' }))

    expect(courseInput()).toHaveFocus()
    expect(courseInput()).toHaveValue('CS 18000')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('form'))
    // No behavior option, so the reduced-motion CSS rule decides.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(scrollTo).not.toHaveBeenCalled()
  })

  // R53: deleting the course being edited left "Edit course" with a Save
  // that did nothing.
  test('deleting the course being edited closes the edit', async () => {
    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Edit CS 18000' }))
    expect(screen.getByText('Edit course')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete CS 18000' }))
    })

    expect(screen.getByText('Add a course')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add course' })).toBeInTheDocument()
    expect(courseInput()).toHaveValue('')
  })
})

describe('Grade tracker load failure', () => {
  // R12: a failed read with nothing cached showed "No courses yet" and zero
  // credits, inviting the student to re-enter courses already on the account.
  test('says the courses could not be loaded instead of showing an empty tracker, and Try again reloads', async () => {
    readGrades = () => {
      throw new TypeError('Failed to fetch')
    }
    await renderPage()

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your saved courses')
    expect(screen.queryByText('No courses yet')).toBeNull()
    expect(screen.queryByRole('img', { name: 'No courses yet' })).toBeNull()
    // GPA, credits and courses read '-', not a blank GPA and zeros.
    expect(screen.getAllByText('-')).toHaveLength(3)
    expect(screen.queryByText('0')).toBeNull()

    readGrades = () => ({ grades: [saved] })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('CS 18000')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// The fields were named by placeholders alone, and Credits comes filled in,
// so a student saw a bare number and an unlabelled grade list.
describe('Grade tracker form labels', () => {
  test('labels every field visibly', async () => {
    await renderPage()
    expect(screen.getByLabelText('Course', { selector: 'input' })).toHaveAttribute('placeholder', 'e.g. CS 30200')
    expect(screen.getByLabelText('Term', { selector: 'input' })).toHaveAttribute('placeholder', 'e.g. Fall 2025')
    expect(screen.getByLabelText('Credits', { selector: 'input' })).toHaveValue(3)
    expect(screen.getByLabelText('Letter grade', { selector: 'select' })).toBeInTheDocument()
    for (const text of ['Course', 'Term', 'Credits', 'Letter grade']) {
      expect(screen.getByText(text, { selector: 'label', exact: false })).toBeVisible()
    }
  })
})
