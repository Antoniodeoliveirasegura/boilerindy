import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ShareQrButton from './ShareQrButton'
import { qrCodePath } from '../lib/qrCode'
import { track } from '../lib/usageStats'

// The QR button beside Share (docs/share-links.md, "The QR code"): the view
// on screen as a code with the QR ref, the share link under it to copy, and a
// dialog that hands focus back to the button. lib/qrCode.test.ts reads codes
// back with a decoder; here the code drawn is the one for the right link.

vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))

const LINK = 'https://www.boilerindy.app/transit?route=31&ref=share-bus'
const QR_LINK = 'https://www.boilerindy.app/transit?route=31&ref=qr-bus'
const TEXT = 'The Crimson route, live on BoilerIndy'
const writeText = vi.fn(async (_text: string) => {})

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

function renderButton(getUrl = () => LINK) {
  render(<ShareQrButton page="transit" getUrl={getUrl} text={TEXT} />)
  return screen.getByRole('button', { name: 'Show QR code' })
}

function openDialog(getUrl?: () => string) {
  const button = renderButton(getUrl)
  fireEvent.click(button)
  return { button, dialog: screen.getByRole('dialog', { name: TEXT }) }
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  vi.mocked(track).mockClear()
  setClipboard({ writeText })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
  vi.useRealTimers()
})

describe('the QR code', () => {
  test('draws the view on screen with the QR ref, black on white, and counts a QR share', () => {
    const { dialog } = openDialog()
    const code = within(dialog).getByRole('img', { name: 'QR code' })
    expect(code.querySelector('path')).toHaveAttribute('d', qrCodePath(QR_LINK).d)
    expect(code.querySelector('path')).toHaveAttribute('fill', '#000')
    expect(code.querySelector('rect')).toHaveAttribute('fill', '#fff')
    // Four white modules round the code.
    const { size } = qrCodePath(QR_LINK)
    expect(code).toHaveAttribute('viewBox', `-4 -4 ${size + 8} ${size + 8}`)
    expect(dialog).toHaveAccessibleDescription("Point a phone's camera at the code to open it. No account needed.")
    expect(track).toHaveBeenCalledWith('share_clicked', { page: 'transit', via: 'qr' })
  })

  test('builds the link when opened, so the code carries the view on screen then', () => {
    let route = '31'
    const button = renderButton(() => `https://www.boilerindy.app/transit?route=${route}&ref=share-bus`)
    route = '27'
    fireEvent.click(button)
    const code = screen.getByRole('img', { name: 'QR code' })
    expect(code.querySelector('path')).toHaveAttribute('d', qrCodePath('https://www.boilerindy.app/transit?route=27&ref=qr-bus').d)
    expect(screen.getByLabelText('Or send the link')).toHaveValue('https://www.boilerindy.app/transit?route=27&ref=share-bus')
  })
})

describe('the link under the code', () => {
  test('is the share link, and Copy link copies it and says so for a moment', async () => {
    vi.useFakeTimers()
    const { dialog } = openDialog()
    const field = within(dialog).getByLabelText('Or send the link')
    expect(field).toHaveValue(LINK)
    expect(field).toHaveAttribute('readonly')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }))
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith(LINK)
    expect(within(dialog).getByRole('button', { name: 'Link copied' })).toBeInTheDocument()
    expect(within(dialog).getByText('Link copied to the clipboard')).toBeInTheDocument()
    // Copying is part of the share already counted.
    expect(track).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(2500))
    expect(within(dialog).getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
  })

  test('is selected to copy by hand when the clipboard refuses it', async () => {
    writeText.mockRejectedValue(new DOMException('Write permission denied', 'NotAllowedError'))
    const { dialog } = openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(within(dialog).getByLabelText('Or send the link')).toHaveFocus())
    expect(within(dialog).queryByRole('button', { name: 'Link copied' })).toBeNull()
  })

  test('is selected with no clipboard at all', () => {
    Reflect.deleteProperty(navigator, 'clipboard')
    const { dialog } = openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }))
    expect(within(dialog).getByLabelText('Or send the link')).toHaveFocus()
  })
})

describe('the dialog', () => {
  test('opens on Done, and Done closes it and hands focus back to the QR button', () => {
    const { button, dialog } = openDialog()
    const done = within(dialog).getByRole('button', { name: 'Done' })
    expect(done).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.click(done)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()
    expect(document.body.style.overflow).toBe('')
  })

  test('Escape and the backdrop close it too', () => {
    const { button } = openDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button).toHaveFocus()

    fireEvent.click(button)
    const backdrop = document.querySelector('[data-share-qr-dialog] .motion-scrim')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('keeps Tab inside it', () => {
    const { dialog } = openDialog()
    const field = within(dialog).getByLabelText('Or send the link')
    const done = within(dialog).getByRole('button', { name: 'Done' })

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(field).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(done).toHaveFocus()
  })

  test('says Copy link again on the next opening', async () => {
    const { button, dialog } = openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy link' }))
    await act(async () => {})
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))

    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
  })
})
