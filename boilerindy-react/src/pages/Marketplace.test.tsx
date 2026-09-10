import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Marketplace from './Marketplace'
import { authRequest } from '../lib/authApi'

// Galleries and pricing choices (#177) on the website: cards and the detail
// gallery read `images` / `priceMode`, and the compose form sends the
// structured `photos` list and `priceMode` the API expects.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))
vi.mock('../lib/usageStats', () => ({ track: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { storage: { from: () => ({}) } } }))
vi.mock('../hooks/useConfirm', () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }) }))

const free = { id: 'free', title: 'Chair', priceCents: 0, images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] }

beforeEach(() => {
  vi.mocked(authRequest)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === '/api/marketplace/capabilities') return { gallery: true, pricing: true }
      if (path === '/api/marketplace/free') return { listing: free }
      return {
        listings: [free, { id: 'offer', title: 'Desk', priceMode: 'best_offer', priceCents: null }, { id: 'unknown', title: 'Lamp', priceCents: null }],
        canPost: true,
        hasMore: false,
      }
    })
})

it('distinguishes Free, Best offer and unspecified prices and displays the entire gallery', async () => {
  render(<Marketplace />)
  expect(await screen.findByText('Free')).toBeInTheDocument()
  expect(screen.getByText('Best offer')).toBeInTheDocument()
  expect(screen.getByText('Contact for price')).toBeInTheDocument()
  fireEvent.click(screen.getByText('Chair'))
  expect(await screen.findByAltText('Chair photo 1')).toHaveAttribute('src', free.images[0])
  expect(screen.getByAltText('Chair photo 2')).toHaveAttribute('src', free.images[1])
})

it('posts a structured best offer and ordered image links', async () => {
  render(<Marketplace />)
  fireEvent.click(await screen.findByText('Post a listing'))
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Desk' } })
  fireEvent.change(screen.getByLabelText('Pricing'), { target: { value: 'best_offer' } })
  fireEvent.change(screen.getByLabelText('Image links'), { target: { value: free.images.join('\n') } })
  fireEvent.click(screen.getByText('Post listing'))
  await waitFor(() => expect(authRequest).toHaveBeenCalledWith('/api/marketplace', expect.objectContaining({ method: 'POST' })))
  const options = vi.mocked(authRequest).mock.calls.find(([path, options]) => path === '/api/marketplace' && options?.method === 'POST')?.[1]
  expect(JSON.parse(String(options?.body))).toMatchObject({ priceMode: 'best_offer', priceCents: null, photos: free.images.map((url) => ({ url })) })
})
