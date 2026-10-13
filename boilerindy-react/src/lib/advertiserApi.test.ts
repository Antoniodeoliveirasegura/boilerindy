import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  advertiserSignIn,
  createCampaign,
  getAdvertiserSession,
  getCampaignStats,
  listCampaigns,
  updateCampaign,
} from './advertiserApi'

// An advertiser whose session ended after RequireAdvertiser let the dashboard
// in got "You must sign in" over a false "No campaigns yet" and stayed put.
// A 401 from a campaign read now sends them back to the sign-in page, as
// authRequest does for students, while a wrong password on the sign-in form
// still comes back to the form as an error. Saving a campaign does not
// redirect: the full page load threw away the form the advertiser had filled
// in, so the dashboard keeps it open and asks them to sign in again.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const SIGNED_OUT_401 = { error: { message: 'You must sign in to the advertiser portal.', status: 401 } }

// Settles to 'pending' when the promise has neither resolved nor rejected by
// the time a few macrotasks have run.
function stateOf(promise: Promise<unknown>) {
  return Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
  ])
}

let replace: ReturnType<typeof vi.fn>

function stubLocation(pathname: string) {
  replace = vi.fn()
  vi.stubGlobal('location', { ...window.location, pathname, replace })
}

beforeEach(() => stubLocation('/advertise/dashboard'))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('advertiserRequest on a 401', () => {
  test('a campaign call sends the advertiser to sign in with the session-expired notice and never settles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    expect(await stateOf(listCampaigns())).toBe('pending')
    expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired')
  })

  test('so does the stats read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    expect(await stateOf(getCampaignStats('cmp-1'))).toBe('pending')
    expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired')
  })

  test('creating a campaign rejects with the 401 and stays on the page, so the form survives', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    await expect(createCampaign({ name: 'Fall coffee promo' })).rejects.toMatchObject({ status: 401 })
    expect(replace).not.toHaveBeenCalled()
  })

  test('saving an edit rejects with the 401 and stays on the page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    await expect(updateCampaign('cmp-1', { name: 'Fall coffee promo' })).rejects.toMatchObject({ status: 401 })
    expect(replace).not.toHaveBeenCalled()
  })

  test('a status change that opts in goes back to sign in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    expect(await stateOf(updateCampaign('cmp-1', { status: 'pending_review' }, { redirectOn401: true }))).toBe(
      'pending',
    )
    expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired')
  })

  test('a wrong password on sign-in rejects with its message instead of redirecting', async () => {
    stubLocation('/advertise')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid email or password.', status: 401 } })),
    )

    await expect(advertiserSignIn('ads@example.com', 'wrong-password')).rejects.toMatchObject({
      message: 'Invalid email or password.',
      status: 401,
    })
    expect(replace).not.toHaveBeenCalled()
  })

  test('the sign-in call is left to its caller even when made away from /advertise', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid email or password.', status: 401 } })),
    )

    await expect(advertiserSignIn('ads@example.com', 'wrong-password')).rejects.toMatchObject({ status: 401 })
    expect(replace).not.toHaveBeenCalled()
  })

  test('the /me probe is left to its caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    await expect(getAdvertiserSession()).rejects.toMatchObject({ status: 401 })
    expect(replace).not.toHaveBeenCalled()
  })

  test('a 401 asked from the sign-in page itself does not reload it', async () => {
    stubLocation('/advertise')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, SIGNED_OUT_401)))

    await expect(listCampaigns()).rejects.toMatchObject({ status: 401 })
    expect(replace).not.toHaveBeenCalled()
  })

  test('other errors still reject with the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(500, { error: { message: 'Could not load campaigns.', status: 500 } })),
    )

    await expect(listCampaigns()).rejects.toMatchObject({ message: 'Could not load campaigns.', status: 500 })
    expect(replace).not.toHaveBeenCalled()
  })
})
