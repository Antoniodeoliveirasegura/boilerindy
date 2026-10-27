import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import AdvertiserDashboard from './Dashboard'

// Navigation bugs on the advertiser dashboard:
// - Sign-out pushed /advertise, leaving a signed-out dashboard entry behind,
//   so Back showed the sign-in page twice before leaving the portal.
// - A failed sign-out was swallowed and the page left anyway; the live
//   session bounced the advertiser straight back here with no message.
// - A 401 after the session ended left "You must sign in" over a false
//   "No campaigns yet" instead of going back to the sign-in page.
// - Going back to the sign-in page on a 401 from a save reloaded the page and
//   threw away the campaign form the advertiser had just filled in.
// - A failed sign-out showed its error above the screen once the list was
//   scrolled, and the button gave no sign that anything was happening.

vi.mock('../../context/ThemeContext', () => ({ useTheme: () => ({ dark: false, toggleTheme: () => {} }) }))

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type SignOutAnswer = 'ok' | 'server-error' | 'offline' | 'pending'

const SIGNED_OUT_401 = { error: { message: 'You must sign in to the advertiser portal.', status: 401 } }
const DRAFT = { id: 'cmp-1', name: 'Fall coffee promo', placement: 'side-rail', status: 'draft', creative: {} }

function stubAdvertiserApi({
  campaigns = 200,
  list = [],
  writes = 200,
  signOut = 'ok',
}: {
  campaigns?: 200 | 401
  list?: unknown[]
  writes?: 200 | 401
  signOut?: SignOutAnswer
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/advertiser/campaigns') && method !== 'GET') {
      return writes === 200 ? jsonResponse(200, { campaign: DRAFT }) : jsonResponse(401, SIGNED_OUT_401)
    }
    if (url === '/api/advertiser/campaigns') {
      return campaigns === 200 ? jsonResponse(200, { campaigns: list }) : jsonResponse(401, SIGNED_OUT_401)
    }
    if (url === '/api/advertiser/sign-out') {
      if (signOut === 'pending') return new Promise<Response>(() => {})
      if (signOut === 'offline') throw new TypeError('Failed to fetch')
      return signOut === 'ok'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(500, { error: { message: 'Internal server error', status: 500 } })
    }
    return jsonResponse(404, { error: { message: 'Not found', status: 404 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function Where() {
  const { pathname, search } = useLocation()
  const type = useNavigationType()
  return (
    <p data-testid="where" data-navigation={type}>
      {pathname + search}
    </p>
  )
}

function HistoryBack() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      History back
    </button>
  )
}

// Reached from the landing page, so one Back after signing out returns to "/".
function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/', '/advertise/dashboard']} initialIndex={1} useTransitions={false}>
      <Routes>
        <Route path="/" element={<p>Landing</p>} />
        <Route path="/advertise" element={<p>Advertiser sign in</p>} />
        <Route path="/advertise/dashboard" element={<AdvertiserDashboard advertiser={{ companyName: 'Corner Cafe' }} />} />
      </Routes>
      <Where />
      <HistoryBack />
    </MemoryRouter>,
  )
}

let replace: ReturnType<typeof vi.fn>

beforeEach(() => {
  replace = vi.fn()
  vi.stubGlobal('location', { ...window.location, pathname: '/advertise/dashboard', replace })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AdvertiserDashboard sign-out', () => {
  test('replaces the dashboard with the sign-in page, so one Back leaves the portal', async () => {
    stubAdvertiserApi({ signOut: 'ok' })
    renderDashboard()
    await screen.findByText('No campaigns yet')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    // Anchored: the starting /advertise/dashboard already contains "/advertise",
    // so the old wait passed before the sign-out navigation had committed.
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/advertise$/))
    expect(screen.getByTestId('where')).toHaveAttribute('data-navigation', 'REPLACE')

    fireEvent.click(screen.getByRole('button', { name: 'History back' }))
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/)
  })

  test.each<[SignOutAnswer]>([['server-error'], ['offline']])(
    'stays on the dashboard and says so beside the button when sign-out fails (%s)',
    async (signOut) => {
      const fetchMock = stubAdvertiserApi({ signOut })
      renderDashboard()
      await screen.findByText('No campaigns yet')

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Sign-out failed, so you are still signed in. Please try again.')
      // In the sticky header, so it shows however far the list is scrolled.
      expect(alert.closest('header')).not.toBeNull()
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
      expect(fetchMock).toHaveBeenCalledWith('/api/advertiser/sign-out', expect.anything())
      expect(screen.getByTestId('where')).toHaveTextContent('/advertise/dashboard')
    },
  )

  test('disables the button while the sign-out request is in flight', async () => {
    stubAdvertiserApi({ signOut: 'pending' })
    renderDashboard()
    await screen.findByText('No campaigns yet')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('button', { name: 'Signing out…' })).toBeDisabled()
  })
})

describe('AdvertiserDashboard after the session ends', () => {
  test('a 401 on the campaign list goes back to sign in instead of a false empty state', async () => {
    stubAdvertiserApi({ campaigns: 401 })
    renderDashboard()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired'))
    expect(screen.queryByText('No campaigns yet')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('AdvertiserDashboard: a save after the session ends', () => {
  test('creating keeps the form and what was typed, and offers sign-in in a new tab', async () => {
    stubAdvertiserApi({ writes: 401 })
    renderDashboard()
    await screen.findByText('No campaigns yet')

    fireEvent.click(screen.getAllByRole('button', { name: 'New campaign' })[0])
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Spring sale' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your advertiser session ended, so this was not saved.')
    const link = screen.getByRole('link', { name: 'Sign in again in a new tab' })
    expect(link).toHaveAttribute('href', '/advertise?message=session-expired')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Spring sale')
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByTestId('where')).toHaveTextContent('/advertise/dashboard')
  })

  test('saving an edit keeps the form and what was typed', async () => {
    stubAdvertiserApi({ list: [DRAFT], writes: 401 })
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Winter coffee promo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your advertiser session ended, so this was not saved.')
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Winter coffee promo')
    expect(replace).not.toHaveBeenCalled()
  })

  test('a status change with no form open goes back to sign in', async () => {
    stubAdvertiserApi({ list: [DRAFT], writes: 401 })
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/advertise?message=session-expired'))
  })

  test('a status change with a form open keeps the form instead', async () => {
    stubAdvertiserApi({ list: [DRAFT], writes: 401 })
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'New campaign' }))
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Spring sale' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your advertiser session ended')
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Spring sale')
    expect(replace).not.toHaveBeenCalled()
  })
})

// Campaign bugs on the dashboard, against an in-memory list that answers the
// way src/routes/advertiser.mjs does:
// - Edit on a second campaign while the first one's form was open kept the
//   first one's fields, and Save changes wrote them over the second campaign.
// - End took a live campaign down for good on one click, with no question.
// - A refused save or status change showed its error at the top of the page,
//   above the screen, so the button seemed to do nothing.
// - Opening or closing a form, or a status change, dropped focus to <body>.
// - Editing an approved (paused) campaign gave no sign that changing its
//   banner sends it back to review.

type Row = { id: string; name: string; placement: string; status: string; creative: Record<string, unknown> }

const ALPHA: Row = {
  id: 'c-a',
  name: 'Campaign Alpha',
  placement: 'side-rail',
  status: 'draft',
  creative: { headline: 'Alpha headline', ctaUrl: 'https://alpha.example/', ctaLabel: 'Visit website' },
}
const BRAVO: Row = {
  id: 'c-b',
  name: 'Campaign Bravo',
  placement: 'dining',
  status: 'draft',
  creative: { headline: 'Bravo headline', ctaUrl: 'https://bravo.example/', ctaLabel: 'Visit website' },
}
const LIVE: Row = { ...BRAVO, id: 'c-live', name: 'Finals coffee', status: 'active' }

function stubCampaigns(rows: Row[], { refuse }: { refuse?: string } = {}) {
  const list = rows.map((r) => ({ ...r }))
  const writes: { method: string; url: string; body: Record<string, unknown> }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/advertiser/campaigns' && method === 'GET') return jsonResponse(200, { campaigns: list })
    if (url.endsWith('/stats')) return jsonResponse(200, { stats: { impressions: 0, taps: 0, ctr: 0 } })
    if (url.startsWith('/api/advertiser/campaigns')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      writes.push({ method, url, body })
      if (refuse) return jsonResponse(400, { error: { message: refuse, status: 400 } })
      if (method === 'POST') {
        const created = { ...(body as unknown as Row), id: 'c-new', status: 'draft' }
        list.unshift(created)
        return jsonResponse(201, { campaign: created })
      }
      const row = list.find((r) => url.endsWith(`/${r.id}`))
      if (!row) return jsonResponse(404, { error: { message: 'Campaign not found.', status: 404 } })
      Object.assign(row, body)
      return jsonResponse(200, { campaign: row })
    }
    return jsonResponse(404, { error: { message: 'Not found', status: 404 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return writes
}

/** The card that shows `name` as its title. */
function cardOf(name: string): HTMLElement {
  const card = screen.getByRole('heading', { name, level: 3 }).closest('.card')
  if (!(card instanceof HTMLElement)) throw new Error(`no card for ${name}`)
  return card
}

describe('AdvertiserDashboard: editing', () => {
  test('Edit on a second campaign while the first is open shows and saves the second one', async () => {
    const writes = stubCampaigns([ALPHA, BRAVO])
    renderDashboard()

    fireEvent.click(within(await findCard('Campaign Alpha')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Campaign Alpha')
    fireEvent.click(within(cardOf('Campaign Bravo')).getByRole('button', { name: 'Edit' }))

    expect(screen.getByRole('heading', { name: 'Edit “Campaign Bravo”' })).toBeInTheDocument()
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Campaign Bravo')
    expect(screen.getByLabelText('Placement')).toHaveValue('dining')
    expect(screen.getByLabelText('Headline')).toHaveValue('Bravo headline')
    expect(screen.getByLabelText('Website URL')).toHaveValue('https://bravo.example/')

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].url).toBe('/api/advertiser/campaigns/c-b')
    expect(writes[0].body).toMatchObject({
      name: 'Campaign Bravo',
      placement: 'dining',
      creative: { headline: 'Bravo headline', ctaUrl: 'https://bravo.example/' },
    })
  })

  test('editing a paused campaign says a banner change sends it back to review', async () => {
    stubCampaigns([{ ...LIVE, status: 'paused' }])
    renderDashboard()

    fireEvent.click(within(await findCard('Finals coffee')).getByRole('button', { name: 'Edit' }))
    expect(
      screen.getByText(
        'This campaign is approved. Changing its banner or placement sends it back to draft, and it needs review again before it can go live.',
      ),
    ).toBeInTheDocument()
  })

  // Issue #527 - Dining, Transit and Events were offered although nothing
  // serves them; an older campaign keeps its value and says it is not shown.
  test('offers only the served placements, and an unserved one says it is not shown', async () => {
    stubCampaigns([ALPHA, BRAVO])
    renderDashboard()

    fireEvent.click(within(await findCard('Campaign Alpha')).getByRole('button', { name: 'Edit' }))
    const options = () => within(screen.getByLabelText('Placement')).getAllByRole('option').map((o) => o.textContent)
    expect(options()).toEqual(['Desktop side banners (recommended)', 'Home dashboard widget'])

    fireEvent.click(within(cardOf('Campaign Bravo')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Placement')).toHaveValue('dining')
    expect(options()).toEqual(['Desktop side banners (recommended)', 'Home dashboard widget', 'Dining (not shown to students)'])
    expect(within(cardOf('Campaign Bravo')).getByText('Dining (not shown to students)')).toBeInTheDocument()
  })

  test('a draft gets no such notice', async () => {
    stubCampaigns([ALPHA])
    renderDashboard()

    fireEvent.click(within(await findCard('Campaign Alpha')).getByRole('button', { name: 'Edit' }))
    expect(screen.queryByText(/needs review again/)).toBeNull()
  })
})

describe('AdvertiserDashboard: ending a campaign', () => {
  test('End asks first, and Cancel leaves the campaign live', async () => {
    const writes = stubCampaigns([LIVE])
    renderDashboard()

    fireEvent.click(within(await findCard('Finals coffee')).getByRole('button', { name: 'End' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('End campaign “Finals coffee”?')).toBeInTheDocument()
    expect(within(dialog).getByText(/stops showing right away and cannot be resumed or edited/)).toBeInTheDocument()
    expect(writes).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(writes).toHaveLength(0)
    expect(within(cardOf('Finals coffee')).getByText('Live')).toBeInTheDocument()
  })

  test('confirming ends it', async () => {
    const writes = stubCampaigns([LIVE])
    renderDashboard()

    fireEvent.click(within(await findCard('Finals coffee')).getByRole('button', { name: 'End' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'End campaign' }))

    await waitFor(() => expect(within(cardOf('Finals coffee')).getByText('Ended')).toBeInTheDocument())
    expect(writes).toEqual([{ method: 'PATCH', url: '/api/advertiser/campaigns/c-live', body: { status: 'ended' } }])
  })
})

describe('AdvertiserDashboard: a refused action shows its error beside it', () => {
  test('a refused Submit for review shows on that campaign card', async () => {
    stubCampaigns([ALPHA, BRAVO], { refuse: 'Banner campaigns need at least 3 photo URLs.' })
    renderDashboard()

    fireEvent.click(within(await findCard('Campaign Alpha')).getByRole('button', { name: 'Submit for review' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Banner campaigns need at least 3 photo URLs.')
    expect(cardOf('Campaign Alpha')).toContainElement(alert)
    expect(cardOf('Campaign Bravo')).not.toContainElement(alert)
  })

  test('a refused Create campaign shows inside the form, beside its button', async () => {
    stubCampaigns([], { refuse: 'Website URL must be a valid URL starting with http:// or https://' })
    renderDashboard()

    fireEvent.click((await screen.findAllByRole('button', { name: 'New campaign' }))[0])
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Bean promo' } })
    fireEvent.change(screen.getByLabelText('Website URL'), { target: { value: 'bean dot co' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create campaign' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Website URL must be a valid URL')
    expect(screen.getByRole('button', { name: 'Create campaign' }).closest('form')).toContainElement(alert)
    expect(screen.getByLabelText('Campaign name')).toHaveValue('Bean promo')
  })
})

describe('AdvertiserDashboard: focus', () => {
  test('New campaign moves focus into the form, and Cancel gives it back to New campaign', async () => {
    stubCampaigns([ALPHA])
    renderDashboard()

    fireEvent.click(await screen.findByRole('button', { name: 'New campaign' }))
    expect(screen.getByLabelText('Campaign name')).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'New campaign' })).toHaveFocus()
  })

  test('Edit moves focus into the form, and Save changes gives it back to the campaign card', async () => {
    stubCampaigns([ALPHA])
    renderDashboard()

    fireEvent.click(within(await findCard('Campaign Alpha')).getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Campaign name')).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull())
    await waitFor(() => expect(cardOf('Campaign Alpha')).toHaveFocus())
  })

  test('a status change that removes the pressed button puts focus on its card', async () => {
    stubCampaigns([ALPHA])
    renderDashboard()

    const submit = within(await findCard('Campaign Alpha')).getByRole('button', { name: 'Submit for review' })
    submit.focus()
    fireEvent.click(submit)

    await waitFor(() => expect(within(cardOf('Campaign Alpha')).getByText('In review')).toBeInTheDocument())
    await waitFor(() => expect(cardOf('Campaign Alpha')).toHaveFocus())
  })
})

async function findCard(name: string): Promise<HTMLElement> {
  await screen.findByRole('heading', { name, level: 3 })
  return cardOf(name)
}
