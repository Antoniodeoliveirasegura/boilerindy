import Icon from '../Icons'
import { CIRCUIT_SITE, postMeta } from '../../lib/campusNews'
import { useCampusNews } from '../../lib/queries/publicData'

// Campus news (issue #470): the latest headlines from The Circuit, Purdue
// Indy's student newspaper. Headline, date, tag, author and the paper's own
// excerpt, each opening the article on its site; nothing more without the
// paper's permission. Self-contained, like SponsoredWidget: it reads the
// shared public query only while it is on the dashboard.

const SHOWN = 4

export default function CampusNewsWidget() {
  const news = useCampusNews()
  const site = news.data?.site || CIRCUIT_SITE
  const posts = (news.data?.posts ?? []).slice(0, SHOWN)

  return (
    <div className="card card-pad r-ink" data-campus-news>
      <div className="card-head">
        <span className="route-badge">
          <Icon name="document" size={18} />
        </span>
        <div>
          <h2 className="card-title lowercase first-letter:uppercase">Campus News</h2>
        </div>
        <a href={site} target="_blank" rel="noopener noreferrer" className="head-link">
          The Circuit
          <Icon name="arrowUpRight" size={14} />
        </a>
      </div>

      {news.isPending ? (
        <ul aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="py-3 border-t border-[var(--color-border)] first:border-t-0 first:pt-0 space-y-2">
              <span className="skeleton block h-4 w-[85%]" />
              <span className="skeleton block h-3 w-[40%]" />
            </li>
          ))}
        </ul>
      ) : posts.length === 0 ? (
        <div className="empty row">
          <span className="ico">
            <Icon name="document" size={18} />
          </span>
          <p>No campus news to show right now.</p>
        </div>
      ) : (
        <ul>
          {posts.map((post) => (
            <li key={post.url} className="py-3 border-t border-[var(--color-border)] first:border-t-0 first:pt-0">
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-display font-bold text-[14.5px] leading-snug text-[var(--color-txt-0)] hover:underline underline-offset-[3px]"
              >
                {post.title}
              </a>
              {postMeta(post) && <p className="mt-1 text-[12px] text-[var(--color-txt-3)] tnum">{postMeta(post)}</p>}
              {post.excerpt && <p className="mt-1 text-[13px] leading-snug text-[var(--color-txt-2)] line-clamp-2">{post.excerpt}</p>}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[12px] text-[var(--color-txt-3)]">
        From{' '}
        <a href={site} target="_blank" rel="noopener noreferrer" className="prose-link">
          The Circuit
        </a>
        , Purdue Indy&apos;s student newspaper.
      </p>
    </div>
  )
}
