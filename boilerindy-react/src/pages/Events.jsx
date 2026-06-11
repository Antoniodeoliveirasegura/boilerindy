import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { linkifyText, stripHtml, cleanAiText } from '../lib/linkifyText'
import Icon from '../components/Icons'

const categoryConfig = {
  campus_event: { 
    label: 'Campus Event',
    bg: 'bg-pink-50 dark:bg-pink-900/20', 
    text: 'text-pink-700 dark:text-pink-400', 
    border: 'border-pink-200 dark:border-pink-800',
    icon: 'users'
  },
  event: { 
    label: 'Event',
    bg: 'bg-indigo-50 dark:bg-indigo-900/20', 
    text: 'text-indigo-700 dark:text-indigo-400', 
    border: 'border-indigo-200 dark:border-indigo-800',
    icon: 'calendar'
  },
  deadline: { 
    label: 'Deadline',
    bg: 'bg-yellow-50 dark:bg-yellow-900/20', 
    text: 'text-yellow-700 dark:text-yellow-400', 
    border: 'border-yellow-200 dark:border-yellow-800',
    icon: 'clock'
  },
}

function formatDate(dateString) {
  const date = new Date(dateString)
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  
  const isToday = date.toDateString() === now.toDateString()
  const isTomorrow = date.toDateString() === tomorrow.toDateString()
  
  if (isToday) return 'Today'
  if (isTomorrow) return 'Tomorrow'
  
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(dateString) {
  const date = new Date(dateString)
  if (date.getHours() === 0 && date.getMinutes() === 0) return 'All day'
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function getRelativeTime(dateString) {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = date - now
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays < 0) return 'Past'
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays <= 7) return `${diffDays} days`
  if (diffDays <= 14) return '1-2 weeks'
  return `${Math.ceil(diffDays / 7)} weeks`
}

function isPast(dateString) {
  return new Date(dateString) < new Date()
}

function getRecsCacheKey() {
  return `ai-event-recs-${new Date().toISOString().slice(0, 10)}`
}

export default function Events() {
  const { onboarding } = useAuth()
  const [items, setItems] = useState([])
  const [selectedCategories, setSelectedCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [showPast, setShowPast] = useState(false)
  const [selectedItem, setSelectedItem] = useState(null)

  const [eventRecs, setEventRecs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(getRecsCacheKey())) ?? null } catch { return null }
  })
  const [recsLoading, setRecsLoading] = useState(false)

  const generateRecs = () => {
    setRecsLoading(true)
    fetch('/api/assistant', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: 'Pick 2-3 upcoming campus events I should attend based on my free time this week. For each, write one sentence: the event name, the day/time, and why I should go. Plain text only, no markdown, no asterisks, no bold, no bullet points. Complete every sentence.',
        }],
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.reply) {
          const clean = cleanAiText(d.reply)
          setEventRecs(clean)
          try { localStorage.setItem(getRecsCacheKey(), JSON.stringify(clean)) } catch {}
        }
      })
      .catch(() => {})
      .finally(() => setRecsLoading(false))
  }

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    setLoading(true)
    try {
      const res = await authRequest('/api/me/calendar?categories=campus_event,event,deadline&limit=500')
      setItems(res.items || [])
    } catch (error) {
      console.error('Failed to load events:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredItems = useMemo(() => {
    let filtered = items
    
    if (selectedCategories.length > 0) {
      filtered = filtered.filter(item => selectedCategories.includes(item.category))
    }
    
    if (!showPast) {
      filtered = filtered.filter(item => !isPast(item.startTime))
    }
    
    return filtered.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
  }, [items, selectedCategories, showPast])

  const groupedItems = useMemo(() => {
    const groups = {}
    for (const item of filteredItems) {
      const dateKey = formatDate(item.startTime)
      if (!groups[dateKey]) groups[dateKey] = []
      groups[dateKey].push(item)
    }
    return groups
  }, [filteredItems])

  const categoryCounts = useMemo(() => {
    const counts = {}
    for (const item of items) {
      counts[item.category] = (counts[item.category] || 0) + 1
    }
    return Object.entries(counts).map(([id, count]) => ({
      id,
      label: categoryConfig[id]?.label || id,
      count
    }))
  }, [items])

  const toggleCategory = (catId) => {
    setSelectedCategories(prev => 
      prev.includes(catId) 
        ? prev.filter(c => c !== catId)
        : [...prev, catId]
    )
  }

  const hasNoSources = onboarding?.linkedSourceCount === 0

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8 pb-24 transition-opacity duration-500 opacity-100">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 animate-fade-in-up">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Campus Events</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">
            {filteredItems.length} upcoming events from your calendar
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)] cursor-pointer">
            <input 
              type="checkbox" 
              checked={showPast} 
              onChange={(e) => setShowPast(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border-2)]"
            />
            Show past events
          </label>
          <button onClick={loadData} className="btn btn-secondary text-[13px] px-4 py-2">
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </div>

      {hasNoSources && (
        <div className="card p-5 mb-6 border-[var(--color-gold)]/30 bg-[var(--color-gold)]/8 animate-fade-in-up">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="text-[16px] font-semibold text-[var(--color-txt-0)]">
                Connect your Brightspace calendar
              </div>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
                Import campus events, career fairs, workshops, and more from Brightspace.
              </p>
            </div>
            <Link to="/setup" className="btn btn-primary text-[13px] px-5 py-2.5 w-fit">
              <Icon name="calendar" size={15} />
              Connect Brightspace
            </Link>
          </div>
        </div>
      )}

      {categoryCounts.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6 animate-fade-in-up stagger-1">
          <button
            onClick={() => setSelectedCategories([])}
            className={`pill whitespace-nowrap ${selectedCategories.length === 0 ? 'pill-active' : ''}`}
          >
            All ({items.length})
          </button>
          {categoryCounts.map(cat => {
            const isActive = selectedCategories.includes(cat.id)
            return (
              <button
                key={cat.id}
                onClick={() => toggleCategory(cat.id)}
                className={`pill whitespace-nowrap ${isActive ? 'pill-active' : ''}`}
              >
                {cat.label} ({cat.count})
              </button>
            )
          })}
        </div>
      )}

      {/* AI Event Recommendations */}
      {!hasNoSources && !loading && items.length > 0 && (
        <div className="card p-4 mb-6 border-[var(--color-gold)]/20 animate-fade-in-up stagger-2">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0">
                <Icon name="sparkles" size={12} className="text-[var(--color-gold-dark)]" />
              </div>
              <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">Recommended for You</span>
            </div>
            <button
              onClick={generateRecs}
              disabled={recsLoading}
              className="text-[11px] text-[var(--color-accent)] hover:underline disabled:opacity-40 shrink-0"
            >
              {recsLoading ? 'Thinking…' : eventRecs ? 'Refresh' : 'Get Picks'}
            </button>
          </div>
          {recsLoading && !eventRecs ? (
            <div className="flex items-center gap-2 text-[13px] text-[var(--color-txt-2)]">
              <div className="w-3.5 h-3.5 border-2 border-[var(--color-accent)] border-t-transparent rounded-full animate-spin shrink-0" />
              Finding events that fit your schedule…
            </div>
          ) : eventRecs ? (
            <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed whitespace-pre-line">{eventRecs}</p>
          ) : (
            <p className="text-[12px] text-[var(--color-txt-3)]">
              AI picks campus events that fit your free time. Tap &ldquo;Get Picks&rdquo; to try it.
            </p>
          )}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-[var(--color-txt-2)]">
          Loading events...
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="card p-8 text-center">
          <Icon name="calendar" size={32} className="mx-auto text-[var(--color-txt-3)] mb-3" />
          <div className="text-[var(--color-txt-1)] font-medium">No events found</div>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">
            {hasNoSources 
              ? 'Connect your Brightspace calendar to see campus events.'
              : selectedCategories.length > 0 
                ? 'Try selecting different categories or showing past events.'
                : 'No upcoming campus events in your calendar.'}
          </p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_340px] gap-6">
          <div className="space-y-6 animate-fade-in-up stagger-2">
            {Object.entries(groupedItems).map(([date, dateItems]) => (
              <div key={date}>
                <div className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
                  {date}
                </div>
                <div className="space-y-2">
                  {dateItems.map(item => {
                    const config = categoryConfig[item.category] || categoryConfig.event
                    const isSelected = selectedItem?.id === item.id
                    const past = isPast(item.startTime)
                    
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSelectedItem(item)}
                        className={`w-full text-left card-interactive p-4 transition-all ${
                          isSelected ? 'ring-2 ring-[var(--color-gold)]' : ''
                        } ${past ? 'opacity-60' : ''}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-10 h-10 rounded-xl ${config.bg} flex items-center justify-center shrink-0`}>
                            <Icon name={config.icon} size={18} className={config.text} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <div className="font-medium text-[var(--color-txt-0)] text-[14px] line-clamp-2">
                                {item.title}
                              </div>
                              <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${config.bg} ${config.text}`}>
                                {config.label}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 mt-1.5 text-[12px] text-[var(--color-txt-2)]">
                              <span className="flex items-center gap-1">
                                <Icon name="clock" size={12} />
                                {formatTime(item.startTime)}
                              </span>
                              {item.location && (
                                <span className="flex items-center gap-1 truncate">
                                  <Icon name="mapPin" size={12} />
                                  {item.location.split(' (')[0].slice(0, 30)}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="lg:sticky lg:top-24 h-fit min-w-0 animate-fade-in-up stagger-3">
            {selectedItem ? (
              <div className="card p-5 min-w-0 overflow-hidden">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <span className={`text-[11px] px-2.5 py-1 rounded-full ${
                    (categoryConfig[selectedItem.category] || categoryConfig.event).bg
                  } ${(categoryConfig[selectedItem.category] || categoryConfig.event).text}`}>
                    {(categoryConfig[selectedItem.category] || categoryConfig.event).label}
                  </span>
                  <button 
                    onClick={() => setSelectedItem(null)}
                    className="text-[var(--color-txt-3)] hover:text-[var(--color-txt-1)]"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
                
                <h3 className="text-[18px] font-semibold text-[var(--color-txt-0)] mb-4">
                  {selectedItem.title}
                </h3>
                
                <div className="space-y-3 mb-5">
                  <div className="flex items-center gap-3 text-[13px]">
                    <div className="w-8 h-8 rounded-lg bg-[var(--color-bg-2)] flex items-center justify-center">
                      <Icon name="calendar" size={15} className="text-[var(--color-txt-2)]" />
                    </div>
                    <div>
                      <div className="text-[var(--color-txt-1)]">{formatDate(selectedItem.startTime)}</div>
                      <div className="text-[var(--color-txt-3)] text-[12px]">{formatTime(selectedItem.startTime)}</div>
                    </div>
                  </div>
                  
                  {selectedItem.location && (
                    <div className="flex items-start gap-3 text-[13px] min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-[var(--color-bg-2)] flex items-center justify-center shrink-0">
                        <Icon name="mapPin" size={15} className="text-[var(--color-txt-2)]" />
                      </div>
                      <div className="text-[var(--color-txt-1)] min-w-0 break-words [overflow-wrap:anywhere]">
                        {/^https?:\/\//i.test(selectedItem.location.trim()) ? (
                          <a
                            href={selectedItem.location.trim()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--color-accent)] hover:underline break-all"
                          >
                            {selectedItem.location.trim().length > 72
                              ? `${selectedItem.location.trim().slice(0, 72)}…`
                              : selectedItem.location.trim()}
                          </a>
                        ) : (
                          selectedItem.location
                        )}
                      </div>
                    </div>
                  )}
                  
                  <div className="flex items-center gap-3 text-[13px]">
                    <div className="w-8 h-8 rounded-lg bg-[var(--color-bg-2)] flex items-center justify-center">
                      <Icon name="clock" size={15} className="text-[var(--color-txt-2)]" />
                    </div>
                    <div className={`${isPast(selectedItem.startTime) ? 'text-[var(--color-txt-3)]' : 'text-[var(--color-txt-1)]'}`}>
                      {isPast(selectedItem.startTime) ? 'Event has passed' : `In ${getRelativeTime(selectedItem.startTime)}`}
                    </div>
                  </div>
                </div>
                
                {selectedItem.description && (
                  <div className="pt-4 border-t border-[var(--color-border)] min-w-0">
                    <div className="text-[12px] font-medium text-[var(--color-txt-3)] uppercase tracking-wider mb-2">
                      Details
                    </div>
                    <div className="text-[13px] text-[var(--color-txt-1)] leading-relaxed min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                      {(() => {
                        const full = stripHtml(selectedItem.description)
                        const truncated = full.length > 800
                        const chunk = truncated ? full.slice(0, 800) : full
                        return (
                          <>
                            {linkifyText(chunk, { maxDisplayLength: 96 })}
                            {truncated ? '…' : ''}
                          </>
                        )
                      })()}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="card p-5 text-center text-[var(--color-txt-2)]">
                <Icon name="users" size={24} className="mx-auto mb-2 text-[var(--color-txt-3)]" />
                <p className="text-[13px]">Select an event to view details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
