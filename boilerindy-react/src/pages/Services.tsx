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
  color: string
  items: ResourceItem[]
}

const resourceGroups: ResourceGroup[] = [
  {
    id: 'academic-support',
    category: 'Academic Support',
    icon: 'graduation',
    color: 'map',
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
    color: 'bus',
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
    color: 'events',
    items: [
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
    color: 'dining',
    items: [
      { name: 'Campus Recreation', desc: 'Fitness, recreation, and wellness resources for Indianapolis students.', icon: 'heart', href: 'https://studentaffairs.indianapolis.iu.edu/health/campus-rec/index.html' },
      { name: 'PUSH Indianapolis', desc: 'Schedule appointments and access Purdue student health services in Indianapolis.', icon: 'health', href: 'https://www.purdue.edu/push/appointments/indianapolis.php' },
    ],
  },
]

const quickLinks = [
  { name: 'Writing Help', desc: 'Open Purdue OWL', icon: 'library', href: 'https://owl.purdue.edu/index.html', color: 'map' },
  { name: 'Meal Plans', desc: 'View Indianapolis plans', icon: 'dining', href: 'https://mealplans.indianapolis.iu.edu/plans/purdue-university-in-indianapolis/index.html', color: 'events' },
  { name: 'BoilerLink', desc: 'Student orgs and clubs', icon: 'users', href: 'https://boilerlink.purdue.edu/', color: 'bus' },
  { name: 'Career Support', desc: 'Purdue Indianapolis CCO', icon: 'rocket', href: 'https://www.cco.purdue.edu/PurdueIndianapolis', color: 'dining' },
]

// In-App Shortcuts: the navigational tiles that lead into other app pages. Data
// driven so the card can lay them out in a size-aware grid (more columns when
// the widget is widened), mirroring the home dashboard's quick-actions widget.
type Shortcut = { to: string; label: string; desc: string; icon?: string; emoji?: string }

const shortcuts: Shortcut[] = [
  { to: '/schedule', icon: 'schedule', label: 'Schedule', desc: 'View imported classes and weekly meetings.' },
  { to: '/grade-tracker', icon: 'graduation', label: 'Grade Tracker', desc: 'Track courses and your term & cumulative GPA.' },
  { to: '/transit', icon: 'bus', label: 'Transit', desc: 'Open campus movement tools and shuttle info.' },
  { to: '/parking', icon: 'parking', label: 'Parking', desc: 'Live garage counts and ST permit rules.' },
  { to: '/dining', icon: 'dining', label: 'Dining', desc: 'Check menus, hours, and dining context.' },
  { to: '/free-food', emoji: '🍕', label: 'Free Food', desc: 'Upcoming events serving free food on campus.' },
  { to: '/lost-found', icon: 'search', label: 'Lost & Found', desc: 'Report or find lost items around campus.' },
  { to: '/guide', icon: 'mapPin', label: 'Neighborhood Guide', desc: 'Student tips for food, study spots, parking, and safety.' },
  { to: '/study-groups', icon: 'users', label: 'Study Groups', desc: 'Find classmates and form study groups by course.' },
  { to: '/perks', icon: 'sparkles', label: 'Campus Perks', desc: 'Local deals and discounts for students.' },
  { to: '/marketplace', icon: 'grid', label: 'Marketplace', desc: 'Buy and sell textbooks, furniture, and more.' },
  { to: '/friends', icon: 'users', label: 'People', desc: 'Meet classmates who share your courses.' },
  { to: '/settings', icon: 'settings', label: 'Settings', desc: 'Manage account, Purdue link, and source setup.' },
]

const colorConfig: Record<string, { bg: string; text: string }> = {
  map: { bg: 'bg-[var(--color-map-bg)]', text: 'text-[var(--color-map-color)]' },
  events: { bg: 'bg-[var(--color-events-bg)]', text: 'text-[var(--color-events-color)]' },
  bus: { bg: 'bg-[var(--color-bus-bg)]', text: 'text-[var(--color-bus-title)]' },
  dining: { bg: 'bg-[var(--color-dining-bg)]', text: 'text-[var(--color-dining-color)]' },
}

// Internal grid columns by widget width. Full class strings keep Tailwind's
// scanner happy (it cannot read computed names). Services widgets are clamped to
// half..full, so only those keys are needed (with a sensible fallback).
const SHORTCUTS_GRID_CLASS: Record<string, string> = {
  half: 'sm:grid-cols-2',
  'three-quarter': 'sm:grid-cols-2 lg:grid-cols-3',
  full: 'sm:grid-cols-2 lg:grid-cols-4',
}
function shortcutsGridClass(size: string) {
  return SHORTCUTS_GRID_CLASS[size] || SHORTCUTS_GRID_CLASS.full
}

const RESOURCE_ITEMS_GRID_CLASS: Record<string, string> = {
  half: 'grid-cols-1',
  'three-quarter': 'grid-cols-1 lg:grid-cols-2',
  full: 'grid-cols-1 sm:grid-cols-2',
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

function ResourceCard({ item }: { item: ResourceItem }) {
  const content = (
    <div className="flex items-start gap-3 p-3 -mx-2 rounded-xl hover:bg-[var(--color-stat)] transition-all duration-200 group">
      <div className="w-9 h-9 rounded-xl bg-[var(--color-stat)] group-hover:bg-[var(--color-bg-3)] flex items-center justify-center shrink-0 transition-colors">
        <Icon name={item.icon} size={17} className="text-[var(--color-txt-2)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-[var(--color-txt-0)] group-hover:text-[var(--color-accent)] flex items-center gap-1.5 transition-colors">
          {item.name}
          <Icon
            name={item.href ? 'external' : 'arrowUpRight'}
            size={12}
            className="text-[var(--color-txt-3)] group-hover:text-[var(--color-accent)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all"
          />
        </div>
        <div className="text-[11px] text-[var(--color-txt-2)] mt-0.5">{item.desc}</div>
      </div>
    </div>
  )

  if (item.href) {
    return <a key={item.name} href={item.href} target="_blank" rel="noreferrer" className="no-underline">{content}</a>
  }

  if (item.link) {
    return <Link key={item.name} to={item.link}>{content}</Link>
  }

  return <div key={item.name}>{content}</div>
}

// One resource group rendered as a customizable widget body. Item columns grow
// with the widget's width so a widened card fills its space instead of leaving a
// tall single column.
function ResourceGroupCard({ group, size }: { group: ResourceGroup; size: string }) {
  const config = colorConfig[group.color]
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-8 h-8 rounded-lg ${config.bg} flex items-center justify-center`}>
          <Icon name={group.icon} size={16} className={config.text} />
        </div>
        <span className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
          {group.category}
        </span>
      </div>
      <div className={`grid gap-x-4 gap-y-0.5 ${resourceItemsGridClass(size)}`}>
        {group.items.map((item) => (
          <ResourceCard key={item.name} item={item} />
        ))}
      </div>
    </div>
  )
}

// In-App Shortcuts widget body. Tile columns follow the widget width so a
// full-width card spreads the shortcuts out instead of squeezing them.
function InAppShortcutsCard({ size }: { size: string }) {
  return (
    <div className="card p-5 sm:p-6">
      <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
        In-App Shortcuts
      </div>
      <div className={`grid gap-3 ${shortcutsGridClass(size)}`}>
        {shortcuts.map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] hover:bg-[var(--color-stat)] transition-colors no-underline"
          >
            <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-txt-0)]">
              {s.emoji ? <span aria-hidden="true">{s.emoji}</span> : <Icon name={s.icon as string} size={16} />}
              {s.label}
            </div>
            <div className="text-[12px] text-[var(--color-txt-2)] mt-1">{s.desc}</div>
          </Link>
        ))}
      </div>
    </div>
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
  const { layout, editing, setEditing, move, moveToTop, reorder, setVisible, setSize, reset } = useServicesLayout(userId)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const visibleWidgets = layout.filter((w) => w.visible && servicesWidgets[w.id])
  const hiddenWidgets = layout
    .filter((w) => !w.visible && servicesWidgets[w.id])
    .map((w) => ({ id: w.id, title: servicesWidgets[w.id].title }))

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="mb-6 animate-fade-in-up">
        <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-2">
          Purdue Indianapolis
        </div>
        <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Student Services And Resources</h1>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1 max-w-[760px]">
          Official academic, campus life, transit, dining, career, and wellness links gathered into one screen so you do not have to keep hunting through Purdue and Indianapolis sites.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8 animate-fade-in-up stagger-1">
        {quickLinks.map((link) => {
          const config = colorConfig[link.color]
          return (
            <a
              key={link.name}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="card card-interactive p-5 text-center group no-underline"
            >
              <div className={`w-12 h-12 rounded-xl ${config.bg} flex items-center justify-center mx-auto mb-3 group-hover:scale-110 transition-transform duration-300`}>
                <Icon name={link.icon} size={22} className={config.text} />
              </div>
              <div className="text-[14px] font-medium text-[var(--color-txt-0)] group-hover:text-[var(--color-accent)] transition-colors flex items-center justify-center gap-1.5">
                {link.name}
                <Icon name="external" size={12} />
              </div>
              <div className="text-[12px] text-[var(--color-txt-2)] mt-0.5">{link.desc}</div>
            </a>
          )
        })}
      </div>

      {/* Customize toolbar - toggles widget edit mode for the resource board. */}
      <div className="flex items-center justify-between gap-3 mb-5 sm:mb-6">
        <p className="text-[12px] text-[var(--color-txt-3)] min-h-[1rem]">
          {editing
            ? 'Drag a card or use the arrows to reorder. Resize with − / +, hide with ×; add hidden cards below.'
            : ''}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {editing && (
            <button
              type="button"
              onClick={() => setShowResetConfirm(true)}
              className="btn btn-secondary text-[12px] px-4 py-2"
            >
              <Icon name="refresh" size={14} />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            className={`btn text-[12px] px-4 py-2 ${editing ? 'btn-primary' : 'btn-secondary'}`}
          >
            <Icon name={editing ? 'check' : 'settings'} size={14} />
            {editing ? 'Done' : 'Customize'}
          </button>
        </div>
      </div>

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

      <div className="card p-5 sm:p-6 mt-8 bg-gradient-to-br from-[var(--color-gold-dark)] to-[#2A1E0A] border-[var(--color-gold)]/20 animate-fade-in-up">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
          <div className="w-14 h-14 rounded-2xl bg-[var(--color-gold)]/20 flex items-center justify-center shrink-0 mx-auto sm:mx-0">
            <Icon name="sparkles" size={28} className="text-[var(--color-gold)]" />
          </div>
          <div className="flex-1 min-w-0 text-center sm:text-left">
            <div className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-gold)] leading-snug">
              Need help finding something?
            </div>
            <p className="text-[13px] sm:text-[14px] text-[var(--color-gold)]/75 mt-1.5 leading-relaxed max-w-xl mx-auto sm:mx-0">
              Open the Campus Assistant to get directed to official Purdue and Indianapolis resources-writing, advising,
              health, transit, dining, careers, and more.
            </p>
          </div>
          <button
            type="button"
            onClick={openCampusAssistantForResources}
            className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-gold)] text-[var(--color-gold-dark)] border border-[var(--color-gold)]/30 text-[13px] sm:text-[14px] px-5 py-3 sm:py-2.5 font-semibold hover:bg-[var(--color-gold-light)] active:scale-[0.98] transition-all min-h-[44px] sm:min-h-0"
          >
            <Icon name="sparkles" size={16} className="text-[var(--color-gold-dark)]" />
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
