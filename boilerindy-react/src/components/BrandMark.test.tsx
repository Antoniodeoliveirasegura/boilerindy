import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import BrandMark from './BrandMark'
import appIcon from '../../public/app-icon.svg?raw'
import markLight from '../../public/brand/mark-light.svg?raw'
import markDark from '../../public/brand/mark-dark.svg?raw'

// Issue #433: Monument Circle replaced the "BI" text badges. The mark must follow
// the app's own `dark` class on <html>, not the device setting, and stay
// decorative so the "BoilerIndy" text beside it names the link.

afterEach(cleanup)

describe('BrandMark', () => {
  test('renders the light and the dark copy, switched by the dark class', () => {
    const { container } = render(<BrandMark />)
    const [light, dark, ...rest] = container.querySelectorAll('img')
    expect(rest).toHaveLength(0)

    expect(light).toHaveAttribute('src', '/brand/mark-light.svg')
    expect(light).toHaveClass('block', 'in-[.dark]:hidden')
    expect(dark).toHaveAttribute('src', '/brand/mark-dark.svg')
    expect(dark).toHaveClass('hidden', 'in-[.dark]:block')

    // The switch rides on the dark class itself (in-[.dark]:), not a dark: utility.
    for (const img of [light, dark]) expect(img.className).not.toMatch(/(^|\s)dark:/)
  })

  test('is decorative, so the visible name stays the accessible name', () => {
    render(
      <a href="/">
        <BrandMark />
        BoilerIndy
      </a>,
    )
    for (const img of document.querySelectorAll('img')) expect(img).toHaveAttribute('alt', '')
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link')).toHaveAccessibleName('BoilerIndy')
  })

  test('on an ink surface renders only the copy for dark backgrounds', () => {
    const { container } = render(<BrandMark surface="ink" size={24} />)
    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]).toHaveAttribute('src', '/brand/mark-dark.svg')
    expect(imgs[0]).toHaveAttribute('alt', '')
    expect(imgs[0]).toHaveAttribute('width', '24')
  })

  test('sizes both images and passes classes to the wrapper', () => {
    const { container } = render(<BrandMark size={20} className="shadow-sm" />)
    expect(container.firstElementChild).toHaveClass('inline-flex', 'shrink-0', 'shadow-sm')
    for (const img of container.querySelectorAll('img')) {
      expect(img).toHaveAttribute('width', '20')
      expect(img).toHaveAttribute('height', '20')
    }
  })
})

// The copies are written by scripts/render-icons.mjs; this catches app-icon.svg
// changing without a re-run, or a copy edited by hand. An XML parse here, string
// slicing there, so the two cannot share a bug. The mark sits straight on the
// page, so each copy leaves out the tile (the rounded rect that fills the whole
// icon) and the blurred shadow the tile casts at its foot.
describe('public/brand copies of app-icon.svg', () => {
  const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml')
  const source = parse(appIcon)
  const tileParts = 'rect[width="64"][height="64"], ellipse[fill="#000"][filter]'

  test.each([
    ['light', markLight],
    ['dark', markDark],
  ])('mark-%s.svg is the app icon group of that name, without the tile or the switch', (name, copyText) => {
    const copy = parse(copyText)
    expect(copy.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(copy.getElementsByTagName('style')).toHaveLength(0)
    expect(copy.documentElement.getAttribute('viewBox')).toBe(source.documentElement.getAttribute('viewBox'))

    const group = source.querySelector(`svg > g[class="${name}"]`)
    expect(group).not.toBeNull()
    expect(group!.querySelectorAll(tileParts)).toHaveLength(2)
    const expected = group!.cloneNode(true) as Element
    expected.removeAttribute('class')
    for (const part of [...expected.querySelectorAll(tileParts)]) part.remove()
    expect(copy.documentElement.children).toHaveLength(1)
    expect(copy.documentElement.children[0].isEqualNode(expected)).toBe(true)
    expect(copy.querySelectorAll(tileParts)).toHaveLength(0)
  })
})
