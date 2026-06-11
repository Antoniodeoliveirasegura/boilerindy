import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ThemeProvider, useTheme } from './ThemeContext'

// Issues #4 (dark/light toggle) and #39 (smooth switch).
function Probe() {
  const { dark, toggleTheme } = useTheme()
  return (
    <div>
      <span data-testid="mode">{dark ? 'dark' : 'light'}</span>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  )
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})
afterEach(cleanup)

describe('ThemeContext', () => {
  test('reads the initial theme from storage', () => {
    localStorage.setItem('pih-theme', 'dark')
    renderProvider()
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  test('toggles the dark class and persists the choice', () => {
    localStorage.setItem('pih-theme', 'light')
    renderProvider()
    expect(screen.getByTestId('mode')).toHaveTextContent('light')

    fireEvent.click(screen.getByText('toggle'))

    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(localStorage.getItem('pih-theme')).toBe('dark')
  })

  test('migrates the legacy pih-dark flag', () => {
    localStorage.setItem('pih-dark', '1')
    renderProvider()
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
  })
})
