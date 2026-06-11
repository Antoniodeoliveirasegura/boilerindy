import Icon from '../components/Icons'
import { Link } from 'react-router-dom'

const resourceGroups = [
  {
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
    ],
  },
  {
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

const colorConfig = {
  map: { bg: 'bg-[var(--color-map-bg)]', text: 'text-[var(--color-map-color)]' },
  events: { bg: 'bg-[var(--color-events-bg)]', text: 'text-[var(--color-events-color)]' },
  bus: { bg: 'bg-[var(--color-bus-bg)]', text: 'text-[var(--color-bus-title)]' },
  dining: { bg: 'bg-[var(--color-dining-bg)]', text: 'text-[var(--color-dining-color)]' },
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

function ResourceCard({ item }) {
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

export default function Services() {
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

      <div className="grid md:grid-cols-2 gap-4 mb-8">
        {resourceGroups.map((category, catIdx) => {
          const config = colorConfig[category.color]
          return (
            <div
              key={category.category}
              className="card p-5 animate-fade-in-up"
              style={{ animationDelay: `${catIdx * 0.08 + 0.15}s` }}
            >
              <div className="flex items-center gap-3 mb-4">
                <div className={`w-8 h-8 rounded-lg ${config.bg} flex items-center justify-center`}>
                  <Icon name={category.icon} size={16} className={config.text} />
                </div>
                <span className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
                  {category.category}
                </span>
              </div>

              <div className="space-y-1">
                {category.items.map((item) => (
                  <ResourceCard key={item.name} item={item} />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-4">
        <div className="card p-5 sm:p-6 bg-gradient-to-br from-[var(--color-gold-dark)] to-[#2A1E0A] border-[var(--color-gold)]/20 animate-fade-in-up stagger-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
            <div className="w-14 h-14 rounded-2xl bg-[var(--color-gold)]/20 flex items-center justify-center shrink-0 mx-auto sm:mx-0">
              <Icon name="sparkles" size={28} className="text-[var(--color-gold)]" />
            </div>
            <div className="flex-1 min-w-0 text-center sm:text-left">
              <div className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-gold)] leading-snug">
                Need help finding something?
              </div>
              <p className="text-[13px] sm:text-[14px] text-[var(--color-gold)]/75 mt-1.5 leading-relaxed max-w-xl mx-auto sm:mx-0">
                Open the Campus Assistant to get directed to official Purdue and Indianapolis resources—writing, advising,
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

        <div className="card p-6 animate-fade-in-up">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-4">
            In-App Shortcuts
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Link to="/schedule" className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] hover:bg-[var(--color-stat)] transition-colors no-underline">
              <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-txt-0)]">
                <Icon name="schedule" size={16} />
                Schedule
              </div>
              <div className="text-[12px] text-[var(--color-txt-2)] mt-1">View imported classes and weekly meetings.</div>
            </Link>
            <Link to="/transit" className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] hover:bg-[var(--color-stat)] transition-colors no-underline">
              <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-txt-0)]">
                <Icon name="bus" size={16} />
                Transit
              </div>
              <div className="text-[12px] text-[var(--color-txt-2)] mt-1">Open campus movement tools and shuttle info.</div>
            </Link>
            <Link to="/dining" className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] hover:bg-[var(--color-stat)] transition-colors no-underline">
              <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-txt-0)]">
                <Icon name="dining" size={16} />
                Dining
              </div>
              <div className="text-[12px] text-[var(--color-txt-2)] mt-1">Check menus, hours, and dining context.</div>
            </Link>
            <Link to="/settings" className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] hover:bg-[var(--color-stat)] transition-colors no-underline">
              <div className="flex items-center gap-2 text-[14px] font-medium text-[var(--color-txt-0)]">
                <Icon name="settings" size={16} />
                Settings
              </div>
              <div className="text-[12px] text-[var(--color-txt-2)] mt-1">Manage account, Purdue link, and source setup.</div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
