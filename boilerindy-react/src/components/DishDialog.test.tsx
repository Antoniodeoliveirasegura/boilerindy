import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DishDialog from './DishDialog'
import type { MenuItem } from '../lib/dining'

// Issue #468: a dish's details. The row's compact facts show at once, the
// rest loads from GET /api/dining/foods/:id, and nothing the feed lacks is
// invented: no placeholder photo, no allergen claim.

const CHICKEN: MenuItem = {
  id: 2577937,
  name: 'Honey Garlic Fried Chicken',
  calories: 326,
  icons: ['Good Source of Protein'],
  serving: '6 oz',
  protein: 21,
  carbs: 18,
  fat: 19,
  sodium: 610,
  thumb: 'https://images.example.test/chicken.220x0.jpg',
  desc: 'Crispy chicken in a honey garlic glaze.',
}

const DETAIL = {
  ok: true,
  date: '2026-10-14',
  food: {
    id: 2577937,
    name: 'Honey Garlic Fried Chicken',
    description: 'Crispy chicken in a honey garlic glaze, with scallions.',
    image: 'https://images.example.test/chicken.1024x0.jpg',
    thumb: 'https://images.example.test/chicken.220x0.jpg',
    serving: '6 oz',
    ingredients: 'Breaded Honey Chicken^, Honey Garlic Sauce^',
    icons: ['Good Source of Protein'],
    nutrition: { calories: 326, g_fat: 19, g_protein: 21, mg_sodium: 610, mg_iron: 1.6 },
  },
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(DETAIL)))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderDialog(props: Partial<Parameters<typeof DishDialog>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const view = render(
    <QueryClientProvider client={client}>
      <button type="button">Opener</button>
      <DishDialog item={CHICKEN} date="2026-10-14" station="Homestyle" onClose={onClose} {...props} />
    </QueryClientProvider>,
  )
  return { ...view, onClose }
}

describe('DishDialog', () => {
  it('opens on the row\'s facts, then shows the photo, nutrition and ingredients from the detail read', async () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Honey Garlic Fried Chicken' })
    expect(within(dialog).getByText('Homestyle · 6 oz · 326 cal')).toBeInTheDocument()
    expect(within(dialog).getByText('Protein 21 g · Carbs 18 g · Fat 19 g · Sodium 610 mg')).toBeInTheDocument()

    expect(await within(dialog).findByText('Breaded Honey Chicken^, Honey Garlic Sauce^')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/dining/foods/2577937?date=2026-10-14', expect.anything())
    expect(within(dialog).getByRole('img', { name: 'Honey Garlic Fried Chicken' })).toHaveAttribute('src', DETAIL.food.image)
    expect(within(dialog).getByText('Crispy chicken in a honey garlic glaze, with scallions.')).toBeInTheDocument()
    const table = dialog.querySelector('[data-dish-nutrition]') as HTMLElement
    expect(within(table).getByRole('rowheader', { name: 'Total fat' })).toBeInTheDocument()
    expect(within(table).getByText('19 g')).toBeInTheDocument()
    expect(within(dialog).getByText('Iron 1.6 mg')).toBeInTheDocument()
    expect(within(dialog).getByText(/The feed lists no allergens: ask dining staff about allergies\./)).toBeInTheDocument()
  })

  it('moves focus in, keeps Tab inside, closes on Escape and gives focus back', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onClose = vi.fn()
    const view = (item: MenuItem | null) => (
      <QueryClientProvider client={client}>
        <button type="button">Opener</button>
        <DishDialog item={item} date="2026-10-14" station="Homestyle" onClose={onClose} />
      </QueryClientProvider>
    )
    const { rerender } = render(view(null))
    const opener = screen.getByRole('button', { name: 'Opener' })
    opener.focus()
    rerender(view(CHICKEN))

    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // Tab from the last control wraps to the first.
    await screen.findByText('Breaded Honey Chicken^, Honey Garlic Sauce^')
    const focusable = Array.from(screen.getByRole('dialog').querySelectorAll<HTMLElement>('button'))
    focusable[focusable.length - 1].focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(focusable[0]).toHaveFocus()

    rerender(view(null))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('a dish with no photo or description shows neither, and one from an older snapshot fetches nothing', async () => {
    const plain: MenuItem = { name: 'Hamburger Bun', calories: 190, icons: [] }
    renderDialog({ item: plain })
    const dialog = screen.getByRole('dialog', { name: 'Hamburger Bun' })
    expect(within(dialog).queryByRole('img')).toBeNull()
    expect(within(dialog).queryByText(/Loading/)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says when the details could not load, and tries again on request', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'down', status: 500 } }), { status: 500 }))
    renderDialog()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the full details.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Breaded Honey Chicken^, Honey Garlic Sauce^')).toBeInTheDocument()
  })

  it('stars the dish when signed in', async () => {
    const onToggleFavorite = vi.fn()
    renderDialog({ onToggleFavorite, isFavorite: false })
    fireEvent.click(screen.getByRole('button', { name: 'Add Honey Garlic Fried Chicken to favorites' }))
    expect(onToggleFavorite).toHaveBeenCalledWith('Honey Garlic Fried Chicken')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})
