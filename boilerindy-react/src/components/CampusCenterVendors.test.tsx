import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import CampusCenterVendors from './CampusCenterVendors'
import { CAMPUS_CENTER_VENDORS, CAMPUS_CENTER_VENDORS_SOURCE } from '../lib/campusCenterVendors'

// Issue #477: the food court's vendors, one card per floor, with Dine On
// Campus linked for each vendor's hours and the list's source and date.

describe('CampusCenterVendors', () => {
  it('lists every vendor under its floor, with what it serves', () => {
    render(<CampusCenterVendors name="Campus Center" vendors={CAMPUS_CENTER_VENDORS} />)
    const section = screen.getByRole('region', { name: 'Campus Center vendors' })
    expect(section).toHaveTextContent('Campus Center vendors serve from their own counters')
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Level 1, Citizens Commons', 'Level 1', 'Level 2'])
    const level2 = section.querySelector('[data-dining-vendor-floor="Level 2"]') as HTMLElement
    expect(within(level2).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Caribou CoffeeCoffee, tea and pastries',
      'The Daily BagelBagel sandwiches for breakfast and lunch',
    ])
    expect(within(section).getAllByRole('listitem')).toHaveLength(10)
    expect(section.querySelector('img')).toBeNull()
  })

  it('links each vendor\'s hours on Dine On Campus and names its source', () => {
    render(<CampusCenterVendors name="Campus Center" vendors={CAMPUS_CENTER_VENDORS} />)
    const hours = screen.getByRole('link', { name: 'Hours for each vendor' })
    expect(hours).toHaveAttribute('href', 'https://dineoncampus.com/iuindy/hours-of-operation')
    expect(hours).toHaveAttribute('target', '_blank')
    expect(hours).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: 'Restaurants & Services page' })).toHaveAttribute('href', CAMPUS_CENTER_VENDORS_SOURCE)
    expect(screen.getByText(/checked Oct 17, 2026/)).toBeInTheDocument()
  })
})
