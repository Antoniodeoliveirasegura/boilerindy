import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import UpdateToast from './UpdateToast'
import type { RegistrationLike } from '../lib/swUpdate'

// Issue #220 - the prompt appears only once a new worker is waiting, Refresh
// hands the registration to applyUpdate, and Later hides it.

afterEach(cleanup)

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

  test('does not register at all when disabled (dev, no service worker support)', () => {
    const register = vi.fn(async () => registration)
    render(<UpdateToast enabled={false} register={register} apply={() => {}} />)
    expect(register).not.toHaveBeenCalled()
    expect(screen.queryByTestId('sw-update-toast')).toBeNull()
  })
})
