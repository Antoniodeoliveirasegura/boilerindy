import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { getServerWarmupState, resetServerWarmupForTests, startServerWarmup } from '../lib/serverWarmup'
import Login from './Login'

// One object for every render, as the real context's memoized value is.
const auth = vi.hoisted(() => ({
  user: null,
  loading: false,
  hasStoredSession: false as boolean | null,
  onboarding: null,
  establishSession: () => Promise.resolve(null),
  applySession: () => {},
}))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))
vi.mock('../lib/supabase', () => ({
  sendPasswordResetEmail: vi.fn(),
  signInWithEmail: vi.fn(async () => ({})),
  signInWithGoogle: vi.fn(),
  supabase: { auth: { signOut: vi.fn(async () => ({})), getSession: vi.fn(async () => ({ data: { session: null } })) } },
}))

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Two-step sign-in as the server answers it: the password checks out and a
// code is emailed. `verify` and `resend` answer the code step.
function stubSignInApi({ verify, resend }: { verify?: Response; resend?: Response } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/sign-in') return jsonResponse(200, { twoFactorRequired: true, email: 's***@purdue.edu' })
      if (url === '/api/auth/sign-in/verify' && verify) return verify
      if (url === '/api/auth/sign-in/resend' && resend) return resend
      return jsonResponse(404, { error: { message: 'Not found', status: 404 } })
    }),
  )
}

const restartAnswer = () =>
  jsonResponse(400, { error: { message: 'This sign-in timed out. Enter your password again.', status: 400, restart: true } })

function renderLogin(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]} useTransitions={false}>
      <Login />
    </MemoryRouter>,
  )
}

const emailField = () => document.getElementById('email') as HTMLInputElement
const passwordField = () => document.getElementById('password') as HTMLInputElement

async function reachCodeStep() {
  fireEvent.change(emailField(), { target: { value: 'student@purdue.edu' } })
  fireEvent.change(passwordField(), { target: { value: 'correct-horse-battery' } })
  fireEvent.click(formSubmit())
  await screen.findByRole('heading', { level: 1, name: 'Check your email' })
}

// The form's submit, not the "Sign in" mode switch above it.
function formSubmit() {
  return document.querySelector('form button[type="submit"]') as HTMLButtonElement
}

// The wake-up ping that never answers, past the point where it counts as slow.
async function serverWaking() {
  void startServerWarmup({ fetchImpl: () => new Promise<Response>(() => {}), slowAfterMs: 0 })
  await waitFor(() => expect(getServerWarmupState().status).toBe('slow'))
}

beforeEach(() => stubSignInApi())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetServerWarmupForTests()
  Object.assign(auth, { user: null, loading: false, hasStoredSession: false })
})

// Issue #389. The page showed a bare "Loading…" until the server answered
// the session check, and a Render cold start makes that up to 30 s.
describe('Login: while the session check is out', () => {
  test('with nothing stored, the form shows at once', () => {
    Object.assign(auth, { loading: true, hasStoredSession: false })
    renderLogin()
    expect(emailField()).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('a stored session shows the skeleton under the heading, signing the student in', () => {
    Object.assign(auth, { loading: true, hasStoredSession: true })
    renderLogin()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back')
    expect(screen.getByRole('status')).toHaveTextContent('Signing you in')
    expect(emailField()).toBeNull()
  })

  // The local read takes a moment, and until it settles the page cannot tell.
  test('the skeleton also covers the moment before the local read settles', () => {
    Object.assign(auth, { loading: true, hasStoredSession: null })
    renderLogin()
    expect(screen.getByRole('status')).toHaveTextContent('Signing you in')
    expect(emailField()).toBeNull()
  })

  // A backend cookie with no Supabase session behind it (rare) shows up only
  // when the server answers, so the form is already on screen by then.
  test('a cookie session found while the form is up sends the student on', async () => {
    Object.assign(auth, { loading: true, hasStoredSession: false })
    const page = () => (
      <MemoryRouter initialEntries={['/login?next=%2Fdashboard']} useTransitions={false}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<p>Dashboard</p>} />
        </Routes>
      </MemoryRouter>
    )
    const { rerender } = render(page())
    expect(emailField()).toBeInTheDocument()

    Object.assign(auth, { loading: false, user: { name: 'Test Student' } })
    rerender(page())
    expect(await screen.findByText('Dashboard')).toBeInTheDocument()
  })

  test('on a cold start the skeleton says the server is waking up', async () => {
    Object.assign(auth, { loading: true, hasStoredSession: true })
    await serverWaking()
    renderLogin()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waking up the server. The first visit after a quiet spell can take up to 30 seconds.',
    )
  })

  // The form is up before the server is, so a cold start's wait lands on the
  // submit, and the floating pill does not show on this page.
  test('a sign-in sent while the server wakes says why it is slow', async () => {
    Object.assign(auth, { loading: true, hasStoredSession: false })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    await serverWaking()
    renderLogin()
    fireEvent.change(emailField(), { target: { value: 'student@purdue.edu' } })
    fireEvent.change(passwordField(), { target: { value: 'correct-horse-battery' } })
    fireEvent.click(formSubmit())

    expect(await screen.findByRole('status')).toHaveTextContent('Waking up the server.')
    expect(formSubmit()).toHaveTextContent('Please wait…')
  })
})

// Students sign in on shared lab and library computers. "Use a different
// account", or a code step that timed out, brought the form back with the last
// student's password still in it, and one press of the eye showed it.
describe('Login: leaving the code step', () => {
  test('"Use a different account" empties the email and password and hides the password', async () => {
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    await reachCodeStep()

    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }))

    expect(emailField()).toHaveValue('')
    expect(passwordField()).toHaveValue('')
    expect(passwordField()).toHaveAttribute('type', 'password')
    await waitFor(() => expect(emailField()).toHaveFocus())
  })

  test('a timed-out code step keeps the email, drops the password and puts focus on it', async () => {
    stubSignInApi({ resend: restartAnswer() })
    renderLogin()
    await reachCodeStep()

    fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }))

    await screen.findByRole('heading', { level: 1, name: 'Welcome back' })
    expect(emailField()).toHaveValue('student@purdue.edu')
    expect(passwordField()).toHaveValue('')
    await waitFor(() => expect(passwordField()).toHaveFocus())
  })

  // The verify button is disabled while it runs, so focus fell to the page.
  test('a wrong code puts focus back on the code field', async () => {
    stubSignInApi({ verify: jsonResponse(400, { error: { message: 'That code is not right.', status: 400 } }) })
    renderLogin()
    await reachCodeStep()
    const codeField = document.getElementById('code') as HTMLInputElement
    fireEvent.change(codeField, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    // Where a mouse press leaves focus once the button is disabled.
    ;(document.activeElement as HTMLElement | null)?.blur()

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not right.')
    await waitFor(() => expect(document.getElementById('code')).toHaveFocus())
  })
})

// Field errors were plain paragraphs: no aria-invalid, no aria-describedby, and
// focus stayed on the submit button, so a screen reader heard nothing.
describe('Login: field errors', () => {
  test('an empty sign-in marks both fields invalid, ties each message to its field and focuses the first', async () => {
    renderLogin()
    fireEvent.click(formSubmit())

    expect(emailField()).toHaveAttribute('aria-invalid', 'true')
    expect(emailField()).toHaveAccessibleDescription('Please enter a valid email.')
    expect(passwordField()).toHaveAttribute('aria-invalid', 'true')
    expect(passwordField()).toHaveAccessibleDescription('Please enter your password.')
    await waitFor(() => expect(emailField()).toHaveFocus())
  })

  test('a sign-up with a short, mismatched password focuses the password', async () => {
    renderLogin('/login?tab=signup')
    fireEvent.change(document.getElementById('name') as HTMLInputElement, { target: { value: 'Test Student' } })
    fireEvent.change(emailField(), { target: { value: 'student@purdue.edu' } })
    fireEvent.change(passwordField(), { target: { value: 'short' } })
    fireEvent.change(document.getElementById('confirm') as HTMLInputElement, { target: { value: 'other' } })
    fireEvent.click(formSubmit())

    expect(document.getElementById('name')).not.toHaveAttribute('aria-invalid')
    expect(passwordField()).toHaveAccessibleDescription('Password must be at least 8 characters.')
    expect(document.getElementById('confirm')).toHaveAccessibleDescription('Passwords do not match.')
    await waitFor(() => expect(passwordField()).toHaveFocus())
  })

  test('fields without an error carry no aria-invalid', () => {
    renderLogin()
    expect(emailField()).not.toHaveAttribute('aria-invalid')
    expect(emailField()).not.toHaveAttribute('aria-describedby')
  })
})

describe('Login: controls and headings', () => {
  // The eye button was announced as just "button", and the mode switch gave
  // no sign of which mode was on.
  test('the eye button says what it does and the mode switch says which mode is on', () => {
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(passwordField()).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Sign in', pressed: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create account', pressed: false }))
    expect(screen.getByRole('button', { name: 'Create account', pressed: true })).toBeInTheDocument()
  })

  // The desktop brand panel carried a second h1.
  test('the form title is the one h1', () => {
    renderLogin()
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]).toHaveTextContent('Welcome back')
  })

  // Issue #526. The Terms rest on "by creating an account or using BoilerIndy",
  // but the screen only linked Privacy, on the sign-up tab, and Google signs
  // students up from either tab with no notice at all.
  test('both tabs show the Terms and Privacy agreement and the age line above the email form', () => {
    renderLogin()
    const terms = screen.getByRole('link', { name: 'Terms of Service' })
    expect(terms).toHaveAttribute('href', '/terms?from=signin')
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy?from=signin')
    const notice = terms.closest('p') as HTMLParagraphElement
    expect(notice).toHaveTextContent('By continuing you agree to the Terms of Service and Privacy Policy and confirm you are 13 or older.')
    // Ahead of the email field in document order, so it is read before either action.
    expect(notice.compareDocumentPosition(emailField()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create account', pressed: false }))
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms?from=signup')
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy?from=signup')
  })

  test('the reset-password form leaves the agreement out', () => {
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.queryByRole('link', { name: 'Terms of Service' })).not.toBeInTheDocument()
  })

  // The button that had focus unmounts as the forms swap, so focus fell to
  // the page and a screen reader heard nothing of the new form.
  test('"Forgot password?" and "Back to sign in" move focus to the email field', async () => {
    renderLogin()
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))
    await screen.findByRole('heading', { level: 1, name: 'Reset your password' })
    await waitFor(() => expect(emailField()).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    await screen.findByRole('heading', { level: 1, name: 'Welcome back' })
    await waitFor(() => expect(emailField()).toHaveFocus())
  })
})
