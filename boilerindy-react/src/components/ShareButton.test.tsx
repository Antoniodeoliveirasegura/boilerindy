import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ShareButton from './ShareButton'
import { track } from '../lib/usageStats'

// The Share button on /transit and /dining (docs/share-links.md): the share
// sheet on a phone, the link copied on a laptop, and the link in a field to
// copy by hand when the clipboard refuses it.

vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

const LINK = 'https://www.boilerindy.app/transit?route=31&ref=share-bus'
const writeText = vi.fn(async (_text: string) => {})
const share = vi.fn(async (_data: ShareData) => {})

function setNavigator(key: 'clipboard' | 'share' | 'canShare', value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true })
}

// A phone or tablet: a touch screen is the coarse pointer.
function touchScreen() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) => ({ matches: query === '(pointer: coarse)', media: query }) as unknown as MediaQueryList,
  )
}

function renderButton(getUrl = () => LINK) {
  render(<ShareButton page="transit" getUrl={getUrl} title="JAGLINE live bus map - BoilerIndy" text="The Crimson route, live on BoilerIndy" />)
  return screen.getByRole('button', { name: 'Share' })
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  share.mockReset().mockResolvedValue(undefined)
  vi.mocked(track).mockClear()
  setNavigator('clipboard', { writeText })
})

afterEach(() => {
  for (const key of ['clipboard', 'share', 'canShare']) Reflect.deleteProperty(navigator, key)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('on a laptop', () => {
  test('copies the link and says so for a moment', async () => {
    vi.useFakeTimers()
    // A laptop browser with a share sheet of its own still copies.
    setNavigator('share', share)
    fireEvent.click(renderButton())

    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith(LINK)
    expect(share).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument()
    expect(screen.getByText('Link copied to the clipboard')).toBeInTheDocument()
    expect(track).toHaveBeenCalledWith('share_clicked', { page: 'transit' })

    act(() => vi.advanceTimersByTime(2500))
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument()
    expect(screen.queryByText('Link copied to the clipboard')).toBeNull()
  })

  test('builds the link when pressed, so it carries the view on screen then', async () => {
    let route = '31'
    const button = renderButton(() => `https://www.boilerindy.app/transit?route=${route}&ref=share-bus`)
    route = '27'
    fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://www.boilerindy.app/transit?route=27&ref=share-bus'))
  })
})

describe('on a phone', () => {
  beforeEach(() => {
    touchScreen()
    setNavigator('share', share)
  })

  test('opens the share sheet with the link, and copies nothing', async () => {
    fireEvent.click(renderButton())
    expect(share).toHaveBeenCalledWith({
      title: 'JAGLINE live bus map - BoilerIndy',
      text: 'The Crimson route, live on BoilerIndy',
      url: LINK,
    })
    await act(async () => {})
    expect(writeText).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('share_clicked', { page: 'transit' })
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument()
  })

  test('does nothing more when the sheet is closed without sharing', async () => {
    share.mockRejectedValue(new DOMException('Share canceled', 'AbortError'))
    fireEvent.click(renderButton())
    await act(async () => {})
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Copy this link to share it')).toBeNull()
  })

  test('copies the link when the sheet refuses it', async () => {
    share.mockRejectedValue(new DOMException('No user activation', 'NotAllowedError'))
    fireEvent.click(renderButton())
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeInTheDocument()
  })

  test('copies the link when the browser cannot share it', async () => {
    setNavigator('canShare', () => false)
    fireEvent.click(renderButton())
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))
    expect(share).not.toHaveBeenCalled()
  })

  test('copies the link in a browser with no share sheet, like some in-app browsers', async () => {
    Reflect.deleteProperty(navigator, 'share')
    fireEvent.click(renderButton())
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK))
  })
})

describe('when the clipboard refuses', () => {
  test('shows the link in a field to copy by hand, and Done closes it', async () => {
    writeText.mockRejectedValue(new DOMException('Write permission denied', 'NotAllowedError'))
    const button = renderButton()
    fireEvent.click(button)

    const field = await screen.findByLabelText('Copy this link to share it')
    expect(field).toHaveValue(LINK)
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Link copied' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Copy this link to share it')).toBeNull()
    expect(button).toHaveFocus()
  })

  test('shows the field with no clipboard at all, and Escape closes it', async () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    fireEvent.click(renderButton())

    const field = await screen.findByLabelText('Copy this link to share it')
    expect(field).toHaveValue(LINK)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByLabelText('Copy this link to share it')).toBeNull()
  })
})

// A Share per listing (each event on /free-food): named after its listing, so
// a screen reader tells the rows' buttons apart, and counted as one event.
describe('in a listing row', () => {
  const EVENT_LINK = 'https://www.boilerindy.app/free-food?event=fuel-up&ref=share-free-food'

  test('is named after its listing, records an event share, and says it copied', async () => {
    render(
      <ShareButton
        page="free-food"
        kind="event"
        inline
        label="Share Boiler Fuel Up"
        getUrl={() => EVENT_LINK}
        title="Free food on campus - BoilerIndy"
        text="Free food at Boiler Fuel Up, on BoilerIndy"
      />,
    )
    const button = screen.getByRole('button', { name: 'Share Boiler Fuel Up' })
    expect(button).toHaveTextContent('Share')
    expect(button).not.toHaveClass('btn')

    fireEvent.click(button)
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith(EVENT_LINK)
    expect(track).toHaveBeenCalledWith('share_clicked', { page: 'free-food', kind: 'event' })
    expect(screen.getByRole('button', { name: 'Link copied' })).toBe(button)
  })
})
