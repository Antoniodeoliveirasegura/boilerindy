import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { useServicesLayout } from '../hooks/useServicesLayout'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { allowedSizesFor } from '../lib/servicesLayoutStore'
import DashboardWidget from '../components/dashboard/DashboardWidget'
import AddWidgetPicker from '../components/dashboard/AddWidgetPicker'
import ConfirmDialog from '../components/ConfirmDialog'
import PageTitle from '../components/PageTitle'

type ResourceItem = {
  name: string
  desc: string
  icon: string
  href?: string
  link?: string
}

type ResourceGroup = {
  // Stable widget id used by the Services layout catalogue (servicesLayout.mjs).
  id: string
  category: string
  icon: string
  // The group's line (route helper class); one route per section card.
  route: string
  items: ResourceItem[]
}

const resourceGroups: ResourceGroup[] = [
  {
    id: 'academic-support',
    category: 'Academic Support',
    icon: 'graduation',
    route: 'r-cls',
    items: [
      { name: 'Online Writing Lab', desc: 'Writing help, citation support, and academic writing guides from Purdue OWL.', icon: 'library', href: 'https://owl.purdue.edu/index.html' },
      { name: 'Disability Resource Center', desc: 'Accessibility accommodations, campus access support, and student disability services.', icon: 'help', href: 'https://www.purdue.edu/drc/' },
      { name: 'Boiler Exams', desc: 'Exam scheduling and testing support for accommodated exams.', icon: 'schedule', href: 'https://www.boilerexams.com/' },
      { name: 'Academic Advising', desc: 'Book advising appointments and connect with your Purdue academic advisor.', icon: 'user', href: 'https://www.purdue.edu/advisors/students/appt.php' },
      { name: 'Academic Success Center', desc: 'Purdue Indianapolis tutoring, coaching, and academic support resources.', icon: 'sparkles', href: 'https://www.purdue.edu/asc/indianapolis/index.html' },
      { name: 'Math Assistance Center', desc: 'Indianapolis math support, tutoring options, and course help.', icon: 'graduation', href: 'https://www.purdue.edu/asc/indianapolis/mac.html' },
      { name: 'Transfer Credit Lookup', desc: 'Check transfer credit equivalencies and course matching information.', icon: 'book', href: 'https://selfservice.mypurdue.purdue.edu/prod/bzwtxcrd.p_select_info' },
    ],
  },
  {
    id: 'transit-and-dining',
    category: 'Transit And Dining',
    icon: 'bus',
    route: 'r-bus',
    items: [
      { name: 'Campus Connect Shuttle', desc: 'Official Purdue shuttle information for campus mobility connections.', icon: 'bus', href: 'https://www.purdue.edu/operations/campus-mobility/home/campus-connect-shuttle/' },
      { name: 'Indianapolis Bus Routes', desc: 'IU Indianapolis bus transportation details and route information.', icon: 'mapPin', href: 'https://parking.indianapolis.iu.edu/transportation/bus/index.html' },
      { name: 'Meal Plans', desc: 'Purdue University in Indianapolis meal plan options and pricing.', icon: 'dining', href: 'https://mealplans.indianapolis.iu.edu/plans/purdue-university-in-indianapolis/index.html' },
      { name: 'CrimsonCard For Purdue', desc: 'Card setup, account access, and Purdue Indianapolis card information.', icon: 'building', href: 'https://crimsoncard.iu.edu/purdue.html' },
      { name: 'Campus Map', desc: 'Find buildings, rooms, and directions inside the app.', icon: 'mapPin', link: '/map' },
      { name: 'Transit Tab', desc: 'Open the app transit page for local routing and campus movement.', icon: 'bus', link: '/transit' },
      { name: 'Parking Status', desc: 'Live space counts in the six ST-permit garages, plus permit rules.', icon: 'parking', link: '/parking' },
    ],
  },
  {
    id: 'campus-life-and-careers',
    category: 'Campus Life And Careers',
    icon: 'users',
    route: 'r-evt',
    items: [
      { name: 'Clubs & Organizations', desc: 'Browse every BoilerLink student org, Indianapolis groups first, inside the app.', icon: 'users', link: '/clubs' },
      { name: 'BoilerLink', desc: 'Student organizations, campus involvement, and Purdue community engagement.', icon: 'users', href: 'https://boilerlink.purdue.edu/' },
      { name: 'Student Employment', desc: 'On-campus jobs, work-study support, and student employment resources.', icon: 'briefcase', href: 'https://www.purdue.edu/studentemployment/site/' },
      { name: 'Student Employment Office', desc: 'Official Purdue Office of Professional Practice student employment support.', icon: 'briefcase', href: 'https://www.opp.purdue.edu/' },
      { name: 'Center For Career Opportunities', desc: 'Purdue Indianapolis career fairs, advising, internships, and employer resources.', icon: 'rocket', href: 'https://www.cco.purdue.edu/PurdueIndianapolis' },
      { name: 'Campus Board', desc: 'Ask questions and connect with other students inside the app.', icon: 'message', link: '/board' },
      { name: 'Events Tab', desc: 'See app-curated events, workshops, and campus happenings.', icon: 'calendar', link: '/events' },
    ],
  },
  {
    id: 'health-and-wellness',
    category: 'Health And Wellness',
    icon: 'heart',
    route: 'r-din',
    items: [
      { name: 'Campus Recreation', desc: 'Fitness, recreation, and wellness resources for Indianapolis students.', icon: 'heart', href: 'https://studentaffairs.indianapolis.iu.edu/health/campus-rec/index.html' },
      { name: 'PUSH Indianapolis', desc: 'Schedule appointments and access Purdue student health services in Indianapolis.', icon: 'health', href: 'https://www.purdue.edu/push/appointments/indianapolis.php' },
    ],
  },
]

const quickLinks = [
  { name: 'Writing Help', desc: 'Open Purdue OWL', icon: 'library', href: 'https://owl.purdue.edu/index.html', route: 'r-cls' },
  { name: 'Meal Plans', desc: 'View Indianapolis plans', icon: 'dining', href: 'https://mealplans.indianapolis.iu.edu/plans/purdue-university-in-indianapolis/index.html', route: 'r-din' },
  { name: 'BoilerLink', desc: 'Student orgs and clubs', icon: 'users', href: 'https://boilerlink.purdue.edu/', route: 'r-evt' },
  { name: 'Career Support', desc: 'Purdue Indianapolis CCO', icon: 'rocket', href: 'https://www.cco.purdue.edu/PurdueIndianapolis', route: 'r-ink' },
]

// In-App Shortcuts: the navigational tiles that lead into other app pages. Data
// driven so the card can lay them out in a size-aware grid (more columns when
// the widget is widened), mirroring the home dashboard's quick-actions widget.
// Each tile wears the line of the page it opens (one route badge per tile).
type Shortcut = { to: string; label: string; desc: string; icon: string; route: string }

const shortcuts: Shortcut[] = [
  { to: '/schedule', icon: 'schedule', route: 'r-cls', label: 'Schedule', desc: 'View imported classes and weekly meetings.' },
  { to: '/grade-tracker', icon: 'graduation', route: 'r-cls', label: 'Grade Tracker', desc: 'Track courses and your term & cumulative GPA.' },
  { to: '/transit', icon: 'bus', route: 'r-bus', label: 'Transit', desc: 'Open campus movement tools and shuttle info.' },
  { to: '/parking', icon: 'parking', route: 'r-bus', label: 'Parking', desc: 'Live garage counts and ST permit rules.' },
  { to: '/clubs', icon: 'users', route: 'r-evt', label: 'Clubs', desc: 'Student orgs in Indianapolis and across Purdue.' },
  { to: '/dining', icon: 'dining', route: 'r-din', label: 'Dining', desc: 'Check menus, hours, and dining context.' },
  { to: '/free-food', icon: 'coffee', route: 'r-din', label: 'Free Food', desc: 'Upcoming events serving free food on campus.' },
  { to: '/lost-found', icon: 'search', route: 'r-ink', label: 'Lost & Found', desc: 'Report or find lost items around campus.' },
  { to: '/guide', icon: 'mapPin', route: 'r-map', label: 'Neighborhood Guide', desc: 'Student tips for food, study spots, parking, and safety.' },
  { to: '/study-groups', icon: 'users', route: 'r-cls', label: 'Study Groups', desc: 'Find classmates and form study groups by course.' },
  { to: '/perks', icon: 'tag', route: 'r-ink', label: 'Campus Perks', desc: 'Local deals and discounts for students.' },
  { to: '/marketplace', icon: 'grid', route: 'r-ink', label: 'Marketplace', desc: 'Buy and sell textbooks, furniture, and more.' },
  { to: '/friends', icon: 'users', route: 'r-ink', label: 'People', desc: 'Meet classmates who share your courses.' },
  { to: '/settings', icon: 'settings', route: 'r-ink', label: 'Settings', desc: 'Manage account, Purdue link, and source setup.' },
]

// Internal grid columns by widget width. Full class strings keep Tailwind's
// scanner happy (it cannot read computed names). Services widgets are clamped to
// half..full, so only those keys are needed (with a sensible fallback). Phones
// keep two columns of stacked tiles.
const SHORTCUTS_GRID_CLASS: Record<string, string> = {
  half: 'grid-cols-2',
  'three-quarter': 'grid-cols-2 lg:grid-cols-3',
  full: 'grid-cols-2 lg:grid-cols-4',
}
function shortcutsGridClass(size: string) {
  return SHORTCUTS_GRID_CLASS[size] || SHORTCUTS_GRID_CLASS.full
}

// Resource rows are divided by 1px rules; in two columns the second row of the
// first line loses its rule too, so no rule sits above either column.
const RESOURCE_ITEMS_GRID_CLASS: Record<string, string> = {
  half: 'grid-cols-1',
  'three-quarter': 'grid-cols-1 lg:grid-cols-2 lg:[&>li:nth-child(2)]:border-t-0',
  full: 'grid-cols-1 sm:grid-cols-2 sm:[&>li:nth-child(2)]:border-t-0',
}
function resourceItemsGridClass(size: string) {
  return RESOURCE_ITEMS_GRID_CLASS[size] || RESOURCE_ITEMS_GRID_CLASS.half
}

function openCampusAssistantForResources() {
  window.dispatchEvent(
    new CustomEvent('open-campus-assistant', {
      detail: {
        message:
          'I am on the Student Services page. Help me find the right official Purdue University or Indianapolis campus resource (writing help, advising, health, transit, dining, careers, etc.). Give a short answer with the best link or next step.',
      },
    }),
  )
}

// One resource link as a divided row: a neutral icon square that takes the
// card's line colour on hover, the name with its link mark, and the summary.
function ResourceCard({ item }: { item: ResourceItem }) {
  const content = (
    <span className="group flex items-start gap-3 min-w-0 flex-1">
      <span className="ico group-hover:bg-[var(--route)] group-hover:text-[var(--route-on)] transition-colors">
        <Icon name={item.icon} size={16} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="font-display font-bold text-[14px] leading-snug text-[var(--color-txt-0)] group-hover:underline underline-offset-[3px] flex items-center gap-1.5">
          {item.name}
          <Icon name={item.href ? 'external' : 'arrowUpRight'} size={12} className="text-[var(--color-txt-3)]" />
        </span>
        <span className="block text-[12.5px] leading-[1.35] text-[var(--color-txt-2)] mt-0.5">{item.desc}</span>
      </span>
    </span>
  )

  if (item.href) {
    return <a key={item.name} href={item.href} target="_blank" rel="noreferrer" className="flex flex-1 min-w-0 no-underline">{content}</a>
  }

  if (item.link) {
    return <Link key={item.name} to={item.link} className="flex flex-1 min-w-0 no-underline">{content}</Link>
  }

  return <div key={item.name} className="flex flex-1 min-w-0">{content}</div>
}

// One resource group rendered as a customizable widget body: a section card on
// the group's line. Item columns grow with the widget's width so a widened card
// fills its space instead of leaving a tall single column.
function ResourceGroupCard({ group, size }: { group: ResourceGroup; size: string }) {
  return (
    <section className={`card card-pad ${group.route}`}>
      <div className="card-head">
        <span className="route-badge">
          <Icon name={group.icon} size={18} />
        </span>
        <div>
          <div className="card-title lowercase first-letter:uppercase">{group.category}</div>
        </div>
      </div>
      <ul className={`rows grid gap-x-6 ${resourceItemsGridClass(size)}`}>
        {group.items.map((item) => (
          <li key={item.name}>
            <ResourceCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// In-App Shortcuts widget body: quick tiles straight on the page, each on the
// line of the page it opens. They are the dense secondary set (small badge,
// tighter tiles, top-aligned so titles line up when a summary wraps) under the
// larger external quick links. Tile columns follow the widget width so a
// full-width board spreads the shortcuts out instead of squeezing them.
function InAppShortcutsCard({ size }: { size: string }) {
  return (
    <section>
      <div className="eyebrow mb-3">In-App Shortcuts</div>
      <div className={`grid gap-2 ${shortcutsGridClass(size)}`}>
        {shortcuts.map((s) => (
          <Link key={s.to} to={s.to} className={`tile ${s.route} items-start gap-3 min-h-0 px-3.5 py-3`}>
            <span className="route-badge sm">
              <Icon name={s.icon} size={14} />
            </span>
            <span>
              <b className="text-[14px]">{s.label}</b>
              <small className="text-[12.5px]">{s.desc}</small>
            </span>
            <Icon name="arrowUpRight" size={16} className="go" />
          </Link>
        ))}
      </div>
    </section>
  )
}

type ServicesWidgetDef = { title: string; render: (size: string) => ReactNode }

const groupById: Record<string, ResourceGroup> = Object.fromEntries(
  resourceGroups.map((g) => [g.id, g]),
)

// Registry: widget id -> display title + renderer. Only ids present here render;
// unknown ids in a saved layout are ignored. The saved layout drives order,
// size, and visibility (servicesLayout.mjs is the shared catalogue / validator).
const servicesWidgets: Record<string, ServicesWidgetDef> = {
  'in-app-shortcuts': { title: 'In-App Shortcuts', render: (size) => <InAppShortcutsCard size={size} /> },
  'academic-support': { title: 'Academic Support', render: (size) => <ResourceGroupCard group={groupById['academic-support']} size={size} /> },
  'transit-and-dining': { title: 'Transit And Dining', render: (size) => <ResourceGroupCard group={groupById['transit-and-dining']} size={size} /> },
  'campus-life-and-careers': { title: 'Campus Life And Careers', render: (size) => <ResourceGroupCard group={groupById['campus-life-and-careers']} size={size} /> },
  'health-and-wellness': { title: 'Health And Wellness', render: (size) => <ResourceGroupCard group={groupById['health-and-wellness']} size={size} /> },
}

export default function Services() {
  const { user } = useAuth()
  const userId = user?.id as string | undefined
  const reducedMotion = usePrefersReducedMotion()
  const { layout, editing, setEditing, move, moveToTop, reorder, setVisible, setSize, reset, saveError } = useServicesLayout(userId)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const visibleWidgets = layout.filter((w) => w.visible && servicesWidgets[w.id])
  const hiddenWidgets = layout
    .filter((w) => !w.visible && servicesWidgets[w.id])
    .map((w) => ({ id: w.id, title: servicesWidgets[w.id].title }))

  return (
    <div className="page">
      <PageTitle>Student Services</PageTitle>
      <header className={`page-head ${editing ? '' : 'max-md:flex-nowrap max-md:items-start'}`}>
        <div className={`flex-1 ${editing ? 'max-md:basis-full' : ''}`}>
          <p className="eyebrow">Purdue Indianapolis</p>
          <h1 className="page-title">Student Services And Resources</h1>
          <p className="page-sub max-w-[760px]">
            Official academic, campus life, transit, dining, career, and wellness links gathered into one screen so you do not have to keep hunting through Purdue and Indianapolis sites.
          </p>
        </div>
        {/* Customize toolbar - toggles widget edit mode for the resource board.
            Same size and phone treatment as Home's: on phones the idle button
            is a compact square whose accessible name stays "Customize". Done
            is ink, not amber: the help panel's button is this view's primary. */}
        <div className="flex items-center gap-2 shrink-0">
          {editing && (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="btn btn-secondary"
            >
              <Icon name="refresh" size={16} />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            className={`btn ${editing ? 'btn-ink' : 'btn-secondary max-md:px-0'}`}
          >
            <Icon name={editing ? 'check' : 'settings'} size={16} />
            <span className={editing ? undefined : 'max-md:sr-only'}>{editing ? 'Done' : 'Customize'}</span>
          </button>
        </div>
      </header>

      {/* The four external quick links are the page's primary row: larger
          tiles and badges than the in-app shortcuts below. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
        {quickLinks.map((link) => (
          <a
            key={link.name}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className={`tile ${link.route} min-h-[88px]`}
          >
            <span className="route-badge lg">
              <Icon name={link.icon} size={22} />
            </span>
            <span>
              <b className="text-[16px]">{link.name}</b>
              <small>{link.desc}</small>
            </span>
            <Icon name="external" size={16} className="go" />
          </a>
        ))}
      </div>

      {/* A refused layout save (issue #202) replaces the hint until the next change. */}
      {saveError ? (
        <p role="alert" className="text-[13px] text-[var(--color-error)] mb-4">
          {saveError}
        </p>
      ) : (
        <p className="text-[13px] text-[var(--color-txt-2)] mb-4 empty:hidden">
          {editing
            ? 'Drag a card or use the arrows to reorder. Resize with − / +, hide with ×; add hidden cards below.'
            : ''}
        </p>
      )}

      <div
        className={
          editing
            ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4'
            : // View mode: 1px row tracks + dense flow turn the grid into a
              // masonry layout so short cards don't leave vertical holes.
              'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-3 sm:gap-x-4 items-start [grid-auto-rows:1px] [grid-auto-flow:row_dense]'
        }
      >
        {visibleWidgets.map((w, idx) => {
          const def = servicesWidgets[w.id]
          return (
            <DashboardWidget
              key={w.id}
              id={w.id}
              title={def.title}
              editing={editing}
              size={w.size}
              allowedSizes={allowedSizesFor(w.id)}
              canMoveUp={idx > 0}
              canMoveDown={idx < visibleWidgets.length - 1}
              onMove={move}
              onMoveTop={moveToTop}
              onResize={setSize}
              onHide={(id) => setVisible(id, false)}
              onDropReorder={reorder}
              reducedMotion={reducedMotion}
            >
              {def.render(w.size)}
            </DashboardWidget>
          )
        })}
      </div>

      {editing && (
        <AddWidgetPicker hiddenWidgets={hiddenWidgets} onAdd={(id) => setVisible(id, true)} />
      )}

      <div className="ink-panel p-5 sm:p-6 mt-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <span className="route-badge lg">
            <Icon name="sparkles" size={22} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="card-title text-[17px] text-[var(--color-ink-txt)]">
              Need help finding something?
            </div>
            <p className="text-[14px] text-[var(--color-ink-dim)] mt-1.5 leading-relaxed max-w-xl">
              Open the Campus Assistant to get directed to official Purdue and Indianapolis resources-writing, advising,
              health, transit, dining, careers, and more.
            </p>
          </div>
          <button
            type="button"
            onClick={openCampusAssistantForResources}
            className="btn btn-primary w-full sm:w-auto shrink-0"
          >
            <Icon name="sparkles" size={16} />
            Open Campus Assistant
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={showResetConfirm}
        icon="refresh"
        title="Reset Services layout?"
        message="This restores the default cards, order, and sizes. Your current layout will be lost."
        confirmLabel="Reset"
        tone="danger"
        onConfirm={() => {
          reset()
          setShowResetConfirm(false)
        }}
        onCancel={() => setShowResetConfirm(false)}
      />
    </div>
  )
}
