import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import UpdateToast from './UpdateToast'
import type { RegistrationLike } from '../lib/swUpdate'

// Issue #220 - the prompt appears only once a new worker is waiting, Refresh
// hands the registration to applyUpdate, and Later hides it.

beforeEach(() => {
  // jsdom has no ResizeObserver; the toast measures itself with one.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const registration = { waiting: null, installing: null, addEventListener() {}, update: async () => {} } as RegistrationLike

describe('UpdateToast', () => {
  test('renders nothing until an update is ready, then offers Refresh and Later', async () => {
    let announce: ((r: RegistrationLike) => void) | null = null
    const register = vi.fn(async ({ onUpdateReady }: { onUpdateReady: (r: RegistrationLike) => void }) => {
      announce = onUpdateReady
      return registration
    })
    const apply = vi.fn()
    render(<UpdateToast enabled register={register} apply={apply} />)

    expect(screen.queryByTestId('sw-update-toast')).toBeNull()
    expect(register).toHaveBeenCalledTimes(1)

    await act(async () => { announce!(registration) })
    const toast = screen.getByTestId('sw-update-toast')
    expect(toast).toHaveTextContent('A new version of BoilerIndy is ready.')

    screen.getByRole('button', { name: 'Refresh' }).click()
    expect(apply).toHaveBeenCalledWith(registration)

    await act(async () => { screen.getByRole('button', { name: 'Later' }).click() })
    expect(screen.queryByTestId('sw-update-toast')).toBeNull()
  })

  // From md the full-width wrapper sat over the assistant button and the
  // bottom of the page and swallowed their taps; on phones the toast sat over
  // the open assistant panel's input row (z-[1200] against the panel's z-50).
  test('only the card takes the pointer, and it layers under the assistant panel', async () => {
    let announce: ((r: RegistrationLike) => void) | null = null
    const register = async ({ onUpdateReady }: { onUpdateReady: (r: RegistrationLike) => void }) => {
      announce = onUpdateReady
      return registration
    }
    render(<UpdateToast enabled register={register} apply={() => {}} />)
    await act(async () => { announce!(registration) })

    const toast = screen.getByTestId('sw-update-toast')
    const wrapper = toast.parentElement!
    expect(wrapper).toHaveClass('pointer-events-none')
    expect(toast).toHaveClass('pointer-events-auto')
    expect(wrapper).toHaveClass('z-[46]')
  })

  test('does not register at all when disabled (dev, no service worker support)', () => {
    const register = vi.fn(async () => registration)
    render(<UpdateToast enabled={false} register={register} apply={() => {}} />)
    expect(register).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sw-update-toast')).toBeNull()
  })
})
