import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Login from './Login'

// One object for every render, as the real context's memoized value is.
const auth = vi.hoisted(() => ({
  user: null,
  loading: false,
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
    <MemoryRouter initialEntries={[entry]}>
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

beforeEach(() => stubSignInApi())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
