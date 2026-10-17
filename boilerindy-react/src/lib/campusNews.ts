// Campus news from The Circuit (issue #470): the shape of GET /api/campus-news
// and the one line of facts each headline carries. Only the headline, date,
// tag, author and the paper's own excerpt are shown, each linking out to the
// article; the paper's text and photos stay on its site.

export type CampusPost = {
  title: string
  url: string
  publishedAt: string | null
  author: string | null
  tag: string | null
  excerpt: string | null
}

export type CampusNews = { ok?: boolean; source?: string; site?: string; posts?: CampusPost[] }

export const CIRCUIT_SITE = 'https://circuitpress.org/'

/** "Oct 1 · News · By Omkar Govil-Nair", leaving out what the post lacks. */
export function postMeta(post: Pick<CampusPost, 'publishedAt' | 'tag' | 'author'>): string {
  const date = post.publishedAt ? new Date(post.publishedAt) : null
  const day =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Indiana/Indianapolis' })
      : null
  return [day, post.tag, post.author ? `By ${post.author}` : null].filter(Boolean).join(' · ')
}
