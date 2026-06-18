// PROTOTYPE — shared content for the design playground. Delete with the rest of
// src/pages/prototype/ once a direction is chosen. The four variants all render
// THIS copy so the only thing changing between them is the design, not the words.

export type Feature = {
  icon: string
  title: string
  desc: string
}

export type TimelineStep = {
  time: string
  icon: string
  title: string
  body: string
}

export const TAGLINE = 'Built for Purdue University Indianapolis'

export const HERO = {
  kicker: 'The campus companion',
  headline: 'The whole campus,\none quiet screen.',
  sub: 'Classes, dining, live buses, deadlines, events and a campus board — stitched together and quietly organized by AI. Stop juggling ten apps.',
  primaryCta: 'Get started — it’s free',
  secondaryCta: 'Take the tour',
}

export const STATS: { value: string; label: string }[] = [
  { value: '12+', label: 'Campus features' },
  { value: 'Live', label: 'Bus & dining' },
  { value: 'AI', label: 'by Gemini' },
  { value: '$0', label: 'For students' },
]

export const FEATURES: Feature[] = [
  { icon: 'grid', title: 'A dashboard that bends to you', desc: 'Drag, hide, and reorder every widget. Your campus arranged exactly how your day runs.' },
  { icon: 'sparkles', title: 'Ask anything', desc: '“When’s my next bus?” Gemini answers in plain language.' },
  { icon: 'dining', title: 'Live dining', desc: 'Menus, hours, and what’s open right now.' },
  { icon: 'bus', title: 'Buses, in human terms', desc: '“3 stops from you — about 6 minutes.” Real-time ETAs, not a raw map dump.' },
  { icon: 'schedule', title: 'Free-time radar', desc: 'Gaps between classes turn into smart suggestions.' },
  { icon: 'document', title: 'Deadline triage', desc: 'Every assignment, ranked by what’s actually urgent.' },
  { icon: 'calendar', title: 'Events that fit', desc: 'Campus happenings matched to your open windows.' },
  { icon: 'message', title: 'Campus board', desc: 'Ask, answer, upvote. The hallway, online.' },
  { icon: 'coffee', title: 'Free food radar', desc: 'Never miss leftover pizza on campus again.' },
  { icon: 'mapPin', title: 'Find anything', desc: 'Buildings, parking, resources — one tap away.' },
]

export const TIMELINE: TimelineStep[] = [
  { time: '8:05 AM', icon: 'schedule', title: 'Heads up: CS 30200 in 25 min', body: 'Your dashboard greets you with the next class, the room, and the walk time.' },
  { time: '11:15 AM', icon: 'sparkles', title: '“You’ve got 90 free minutes”', body: 'BoilerIndy suggests a study block — and tells you Tower Dining is open until 2.' },
  { time: '12:30 PM', icon: 'dining', title: 'Lunch, sorted', body: 'Live menu shows what’s actually being served. Ask AI for the high-protein pick.' },
  { time: '2:00 PM', icon: 'bus', title: 'Catch the shuttle', body: '“Gold route is 2 stops away, ~4 minutes.” You leave at exactly the right time.' },
  { time: '4:30 PM', icon: 'coffee', title: 'Free pizza in ET', body: 'A free-food alert pings before it’s gone. You detour for a slice.' },
  { time: '9:00 PM', icon: 'message', title: 'Wind down on the board', body: 'Someone answered your “best quiet study spot?” thread.' },
]

export const INTEGRATIONS: [string, string][] = [
  ['schedule', 'Brightspace LMS'],
  ['dining', 'Campus Dining'],
  ['bus', 'IndyGo Transit'],
  ['calendar', 'Events Feed'],
  ['mapPin', 'Campus Map'],
  ['sparkles', 'Google Gemini'],
  ['book', 'University Library'],
  ['document', 'Assignment Tracker'],
  ['message', 'Community Board'],
  ['bell', 'Smart Alerts'],
]

export const CTA = {
  headline: 'Your campus is ready when you are.',
  sub: 'Free for every Purdue Indianapolis student. Sign in with your university account and your dashboard builds itself.',
  button: 'Get started free',
}

export const FOOTER_NOTE =
  'A student-built campus companion for Purdue University Indianapolis · Not an official Purdue product'
