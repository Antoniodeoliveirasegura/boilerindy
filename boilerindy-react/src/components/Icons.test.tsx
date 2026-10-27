import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import Icon from './Icons'

afterEach(cleanup)

// Issue #530 - the Google "G" on Continue with Google was one colour, which
// Google's sign-in branding guidelines rule out.
describe('Icon google', () => {
  test('draws the four brand colours and never takes currentColor', () => {
    const { container } = render(<Icon name="google" size={18} />)
    const fills = [...container.querySelectorAll('path')].map((p) => p.getAttribute('fill'))
    expect(fills).toEqual(['#4285F4', '#34A853', '#FBBC05', '#EA4335'])
    expect(container.innerHTML).not.toContain('fill="currentColor"')
  })
})
