import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CampusNewsWidget from './CampusNewsWidget'

// Issue #470: The Circuit's headlines on the dashboard. Headline, date, tag,
// author and excerpt, each opening the article on circuitpress.org in a new
// tab, with the paper credited; nothing of the article itself.

const NEWS = {
  ok: true,
  source: 'The Circuit',
  site: 'https://circuitpress.org/',
  posts: [
    {
      title: 'A Look Inside The Academic Success Building',
      url: 'https://circuitpress.org/a-look-inside-the-academic-success-building/',
      publishedAt: '2026-10-01T16:24:51.000Z',
      author: 'Omkar Govil-Nair',
      tag: 'News',
      excerpt: 'We toured the construction site of the Academic Success Building.',
    },
    { title: 'Fall 2026 Club Guide', url: 'https://circuitpress.org/fall-2026-club-guide/', publishedAt: null, author: null, tag: 'Student Orgs', excerpt: null },
    { title: 'Three', url: 'https://circuitpress.org/three/', publishedAt: null, author: null, tag: null, excerpt: null },
    { title: 'Four', url: 'https://circuitpress.org/four/', publishedAt: null, author: null, tag: null, excerpt: null },
    { title: 'Five', url: 'https://circuitpress.org/five/', publishedAt: null, author: null, tag: null, excerpt: null },
  ],
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(NEWS)))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderWidget() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CampusNewsWidget />
    </QueryClientProvider>,
  )
}

describe('CampusNewsWidget', () => {
  it('lists four headlines that open the articles on The Circuit\'s site, with the facts and the excerpt', async () => {
    renderWidget()
    const link = await screen.findByRole('link', { name: 'A Look Inside The Academic Success Building' })
    expect(link).toHaveAttribute('href', 'https://circuitpress.org/a-look-inside-the-academic-success-building/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText('Oct 1 · News · By Omkar Govil-Nair')).toBeInTheDocument()
    expect(screen.getByText('We toured the construction site of the Academic Success Building.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Fall 2026 Club Guide' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Five' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/campus-news', expect.anything())
    // Credited, and no images of theirs.
    const card = link.closest('[data-campus-news]') as HTMLElement
    expect(within(card).getByText(/Purdue Indy's student newspaper/)).toBeInTheDocument()
    expect(card.querySelector('img')).toBeNull()
  })

  it('says there is nothing to show when the feed is unavailable', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: 'campus_news_unavailable', posts: [] })))
    renderWidget()
    expect(await screen.findByText('No campus news to show right now.')).toBeInTheDocument()
    // The header link and the credit both lead to the paper's site.
    const links = screen.getAllByRole('link', { name: 'The Circuit' })
    expect(links).toHaveLength(2)
    for (const link of links) expect(link).toHaveAttribute('href', 'https://circuitpress.org/')
  })
})
