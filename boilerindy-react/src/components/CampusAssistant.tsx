import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { useSpeechRecognition } from '../lib/useSpeechRecognition'
import AiMarkdown from './AiMarkdown'
import Icon from './Icons'

// Shown only until the briefing lands, and if the briefing request fails.
const fallbackQuestions = [
  'What should I do right now?',
  'What should I work on tonight?',
  'Plan my week',
]

type ChatMessage = { role: string; content: string }
// The welcome message, kept as a marker and worded at render so it follows the
// current first name (issue #369): a name frozen at mount stayed "Student"
// when auth or setup supplied the real one later.
type OpenerMessage = { role: 'assistant'; content: ''; opener: true; headline?: string }
type ThreadMessage = ChatMessage | OpenerMessage

const OPENER: OpenerMessage = { role: 'assistant', content: '', opener: true }

function isOpener(msg: ThreadMessage): msg is OpenerMessage {
  return 'opener' in msg
}

function greeting(firstName: string, headline?: string): string {
  return headline
    ? `Hey ${firstName} - here's where you stand: **${headline}**.\n\nAsk me anything about your schedule, coursework, dining or getting around campus.`
    : `Hey ${firstName}! Ask me anything - e.g. what to do right now with your classes and homework, dining, buses, or where to study.`
}

const historyKey = (userId: string) => `boilerindy-assistant-history-v1-${userId}`
const MAX_STORED_MESSAGES = 20

function loadHistory(userId: string | undefined): ChatMessage[] | null {
  if (!userId) return null
  try {
    const raw = sessionStorage.getItem(historyKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length) return null
    return parsed.filter(
      (m): m is ChatMessage =>
        m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'),
    )
  } catch {
    return null
  }
}

export default function CampusAssistant() {
  const { getFirstName, user } = useAuth()
  const firstName = getFirstName()
  const userId = user?.id as string | undefined
  const { pathname, key: locationKey } = useLocation()
  const navigationType = useNavigationType()

  const [open, setOpen] = useState(false)
  // Any navigation (a link, Back, Forward) closes the panel; the conversation
  // is kept. AppLayout keeps this component mounted across routes, so the
  // panel used to stay open over the next page, its backdrop eating the first
  // tap on the tab bar. Reset while rendering, so the next page never paints
  // with the panel still open. Remembering the history entry it was opened on,
  // as the navbar's menus do, would reopen it on Forward or Back to that entry.
  // A replace on the same page is the page rewriting its own search params
  // (the Clubs search box does after a 300ms pause), not the student leaving,
  // so it keeps the panel open: it used to close one opened mid-debounce.
  const [shownFor, setShownFor] = useState({ key: locationKey, pathname })
  if (shownFor.key !== locationKey) {
    setShownFor({ key: locationKey, pathname })
    if (navigationType !== 'REPLACE' || pathname !== shownFor.pathname) setOpen(false)
  }
  const panelRef = useRef<HTMLDivElement | null>(null)
  const fabRef = useRef<HTMLButtonElement | null>(null)
  // Each message: { role: 'user' | 'assistant', content: string }, or the opener.
  const [messages, setMessages] = useState<ThreadMessage[]>(() => [OPENER])
  const worded = (msg: ThreadMessage): ChatMessage =>
    isOpener(msg) ? { role: 'assistant', content: greeting(firstName, msg.headline) } : msg
  const [quickQuestions, setQuickQuestions] = useState<string[]>(fallbackQuestions)
  const briefingLoaded = useRef(false)
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Voice dictation (issue #19). The base holds whatever was already typed when
  // the mic started so live transcripts append rather than overwrite.
  const speechBaseRef = useRef('')
  const handleTranscript = (text: string) => {
    const base = speechBaseRef.current
    setInput(base ? `${base} ${text}` : text)
  }
  const { supported: micSupported, listening, toggle: toggleMic, stop: stopMic } =
    useSpeechRecognition({ onResult: handleTranscript })

  function handleMicToggle() {
    if (!listening) speechBaseRef.current = input
    toggleMic()
  }

  // Listen for external trigger (e.g. "Ask AI what to do" button on dashboard)
  useEffect(() => {
    const handler = (e: Event) => {
      setOpen(true)
      const detail = (e as CustomEvent<{ message?: string }>).detail
      if (detail?.message) setPendingMessage(detail.message)
    }
    window.addEventListener('open-campus-assistant', handler)
    return () => window.removeEventListener('open-campus-assistant', handler)
  }, [])

  // Fire pending message once the panel is open and messages state is fresh.
  // Clearing the trigger inside the timeout (rather than synchronously) keeps the
  // effect body free of a synchronous setState call.
  useEffect(() => {
    if (!pendingMessage) return
    const message = pendingMessage
    const timer = setTimeout(() => {
      setPendingMessage(null)
      handleSend(message)
    }, 200)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage])

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages, isTyping])

  // Cleared on close, so an Escape right after opening does not pull focus
  // back into the hidden panel.
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => inputRef.current?.focus(), 100)
    return () => clearTimeout(timer)
  }, [open])

  // The closed panel is inert, so focus left inside it (the input, when a
  // navigation or the header's Close button shut it) would drop to the page
  // body. Hand it to the floating button instead. A layout effect, so it runs
  // before the browser clears focus out of the newly inert panel.
  useLayoutEffect(() => {
    if (!open && panelRef.current?.contains(document.activeElement)) fabRef.current?.focus()
  }, [open])

  // Escape closes the panel and hands focus back to the floating button, as
  // the navbar's account menu does. Only Enter in the input was handled, so
  // Escape left the panel open with focus still in it.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      fabRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  // Restore an in-progress conversation so closing the panel or reloading the
  // page does not throw away what was already asked.
  useEffect(() => {
    const stored = loadHistory(userId)
    if (stored) setMessages(stored)
  }, [userId])

  useEffect(() => {
    if (!userId || messages.length <= 1) return
    try {
      sessionStorage.setItem(historyKey(userId), JSON.stringify(messages.slice(-MAX_STORED_MESSAGES).map(worded)))
    } catch {
      /* quota */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, userId])

  // Greet with what is actually going on, not a fixed sentence. Deferred until
  // the panel is first opened so it costs nothing on pages nobody asks from.
  useEffect(() => {
    if (!open || briefingLoaded.current) return
    let cancelled = false
    ;(async () => {
      try {
        const data = (await authRequest('/api/assistant/briefing')) as {
          headline?: string
          chips?: string[]
        }
        if (cancelled) return
        if (data.chips?.length) setQuickQuestions(data.chips)
        // The server's catch path is { headline: '', chips: [] }. Latches only
        // once we have a real greeting, otherwise the next open retries.
        if (!data.headline) return
        briefingLoaded.current = true
        setMessages((prev) => {
          // Only replace the opener, never a real conversation.
          if (prev.length !== 1 || !isOpener(prev[0])) return prev
          return [{ ...OPENER, headline: data.headline }]
        })
      } catch {
        /* keep the plain greeting; the next open retries */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Stop dictation when the panel closes so the mic does not keep listening.
  useEffect(() => {
    if (!open && listening) stopMic()
  }, [open, listening, stopMic])

  function resetConversation() {
    setMessages([OPENER])
    setInput('')
    // Let the next open pull a fresh briefing rather than reusing stale counts.
    briefingLoaded.current = false
    if (userId) {
      try {
        sessionStorage.removeItem(historyKey(userId))
      } catch {
        /* ignore */
      }
    }
  }

  async function handleSend(text: string = input) {
    const userMsg = text.trim()
    if (!userMsg || isTyping) return

    const nextMessages = [...messages, { role: 'user', content: userMsg }]
    setMessages(nextMessages)
    setInput('')
    setIsTyping(true)
    // Event only - the message text itself is never recorded (issue #51).
    track('assistant_message_sent')

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // `page` lets the server tell the model which screen they are on, so it
        // stops suggesting they open the tab they are already looking at.
        body: JSON.stringify({ messages: nextMessages.map(worded), page: pathname }),
      })
      // The session ended: send them to sign in with the notice, as
      // authRequest does for every other read, rather than answer in the panel.
      if (res.status === 401) {
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.replace(`/login?next=${next}&message=session-expired`)
        return
      }
      const data = await res.json()
      // The route's own errors are strings, but requireAuth and the final error
      // handler (a body over the size limit) answer with the envelope
      // { error: { message } }. Passed on whole, that object rendered as an
      // empty reply bubble.
      const error = typeof data.error === 'string' ? data.error : data.error?.message
      const reply = (typeof data.reply === 'string' && data.reply) || error || "Sorry, I couldn't get a response."
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: "Couldn't reach the assistant right now. Try again in a moment." },
      ])
    } finally {
      setIsTyping(false)
    }
  }

  function renderMessage(msg: ChatMessage, idx: number) {
    const isUser = msg.role === 'user'
    return (
      <div
        key={idx}
        className={`flex gap-2.5 animate-fade-in-up ${isUser ? 'flex-row-reverse' : ''}`}
        style={{ animationDelay: `${idx * 0.03}s` }}
      >
        {!isUser && (
          <div className="route-badge sm r-ai w-7 h-7 mt-0.5">
            <Icon name="sparkles" size={14} />
          </div>
        )}
        <div
          className={`text-[14px] px-3.5 py-2.5 rounded-[var(--radius-lg)] max-w-[85%] leading-relaxed
            ${isUser
              ? 'bg-[var(--color-ink)] text-[var(--color-ink-txt)] whitespace-pre-wrap'
              : 'bg-[var(--color-surface)] text-[var(--color-txt-0)] border border-[var(--color-border-2)] border-l-4 border-l-[var(--color-gold)]'
            }`}
        >
          {isUser ? msg.content : <AiMarkdown>{msg.content}</AiMarkdown>}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Backdrop. The panel and its backdrop open on the sheet timing and
          close faster (docs/motion.md). */}
      {/* A mouse shortcut only: Escape and the Close button are the keyboard
          and screen reader ways out, so the scrim stays out of the
          accessibility tree (issue #529). */}
      <div
        aria-hidden="true"
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity ${open ? 'opacity-100 duration-[var(--motion-scrim)]' : 'opacity-0 pointer-events-none duration-[var(--motion-base)]'}`}
        onClick={() => setOpen(false)}
      />

      {/* Chat Window: below md it opens 12px above the lifted button, which sits
          76px up to clear the tab bar (issue #249). A screen under 32rem tall
          (a landscape phone, at any width) has too little height for that, so
          there it sits beside the button instead: 8px above the tab bar below
          md, level with the button from md. Keyed on width, an 844px-wide
          landscape phone got the md placement and its message list shrank to
          a 43px sliver. Inert while closed, so its controls leave the tab
          order and focus cannot stay in it. */}
      <div
        ref={panelRef}
        // A dialog only while open: closed, the panel stays mounted but inert,
        // and should not be announced or found as a second dialog (issue #529).
        role={open ? 'dialog' : undefined}
        aria-label={open ? 'Campus Assistant' : undefined}
        inert={!open}
        className={`fixed bottom-[calc(144px+env(safe-area-inset-bottom))] md:bottom-24 right-4 md:right-6 [@media(max-height:32rem)]:bottom-[calc(70px+env(safe-area-inset-bottom))] [@media(max-height:32rem)]:right-[80px] md:[@media(max-height:32rem)]:bottom-6 md:[@media(max-height:32rem)]:right-[88px] z-50 w-[360px] max-w-[calc(100vw-32px)] [@media(max-height:32rem)]:max-w-[calc(100vw-96px)] transition-[opacity,transform] ${open ? 'opacity-100 translate-y-0 duration-[var(--motion-sheet)] ease-[var(--ease-sheet)]' : 'opacity-0 translate-y-4 pointer-events-none duration-[var(--motion-base)] ease-[var(--ease-exit)]'}`}
      >
        {/* The card is capped to the room between the top bar (56px, 64px from
            md) plus an 8px gap and its own bottom offset (144px below md, 96px
            from md; on a short screen 70px below md and 24px from md), and the
            message list gives way inside it. Without the cap, landscape phones
            pushed the header and its Close button 85 to 150px above the
            screen. If even the header, quick questions and input row do not
            fit, justify-end takes the overflow off the top, not the input. */}
        <div data-testid="assistant-panel" className="card p-0 overflow-hidden flex flex-col justify-end max-h-[calc(100dvh-208px-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:max-h-[calc(100dvh-134px-env(safe-area-inset-bottom))] md:max-h-[calc(100dvh-168px)] md:[@media(max-height:32rem)]:max-h-[calc(100dvh-96px)] shadow-[var(--shadow-xl)] border-[var(--color-border-2)]">
          {/* Header: an ink plate in both themes. On a short screen it, the
              quick questions and the input row each give up 4px of padding a
              side, so a 375px-tall landscape phone keeps an 80px message list. */}
          <div className="on-ink bg-[var(--color-ink)] px-3 py-3 [@media(max-height:32rem)]:py-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="route-badge lg r-ai">
                <Icon name="sparkles" size={20} />
              </div>
              <div className="min-w-0">
                <div className="font-display text-[15px] font-extrabold tracking-[-0.01em] text-[var(--color-ink-txt)]">BoilerIndy</div>
                <div className="text-[11.5px] text-[var(--color-ink-dim)] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#3FCB78]" />
                  Campus assistant
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 1 && (
                <button
                  onClick={resetConversation}
                  aria-label="Start a new conversation"
                  title="New conversation"
                  className="icon-btn w-10 h-10"
                >
                  <Icon name="refresh" size={16} />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                aria-label="Close the assistant"
                className="icon-btn w-10 h-10"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          </div>

          {/* Messages: at least 200px tall while the card's cap still leaves room
              for that, the header, input row and card border (135px) and the
              quick questions (one 44px row below md, up to four wrapped rows,
              164px, from md). On shorter screens the floor drops away so the
              header stays on screen (issue #249). */}
          <div
            ref={messagesRef}
            className="min-h-[min(200px,calc(100dvh-387px-env(safe-area-inset-bottom)))] md:min-h-[min(200px,calc(100dvh-467px))] max-h-[340px] overflow-y-auto p-4 space-y-3 bg-[var(--color-surface)]"
          >
            {messages.map((msg, idx) => renderMessage(worded(msg), idx))}

            {isTyping && (
              <div className="flex gap-2.5 animate-fade-in">
                <div className="route-badge sm r-ai w-7 h-7">
                  <Icon name="sparkles" size={14} />
                </div>
                <div className="bg-[var(--color-surface)] border border-[var(--color-border-2)] border-l-4 border-l-[var(--color-gold)] rounded-[var(--radius-lg)] px-4 py-3">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-[2px] bg-[var(--color-txt-3)] animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 rounded-[2px] bg-[var(--color-txt-3)] animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 rounded-[2px] bg-[var(--color-txt-3)] animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick Questions: one row that scrolls sideways below md, so the five
              pills take one line instead of five on a phone (issue #249). From md
              they wrap only on screens at least 32rem tall: on a landscape phone
              the wrapped rows left the conversation no room. */}
          {messages.length <= 2 && !isTyping && (
            <div className="shrink-0 px-4 pb-3 [@media(max-height:32rem)]:pb-2 flex gap-2 overflow-x-auto scrollbar-hide md:[@media(min-height:32rem)]:flex-wrap md:[@media(min-height:32rem)]:overflow-visible bg-[var(--color-surface)]">
              {quickQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(q)}
                  className="shrink-0 whitespace-nowrap inline-flex items-center min-h-[32px] px-3 rounded-[var(--radius-md)] border-[1.5px] border-[var(--color-border-2)] bg-[var(--color-surface)] font-display text-[12px] font-bold text-[var(--color-txt-1)] hover:border-[var(--color-border-3)] hover:text-[var(--color-txt-0)] transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="p-3 [@media(max-height:32rem)]:py-2 border-t border-[var(--color-border-2)] bg-[var(--color-surface)]">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                placeholder={listening ? 'Listening…' : 'Ask about campus...'}
                aria-label="Ask the Campus Assistant"
                className="input flex-1 min-w-0 text-[14px]"
                disabled={isTyping}
              />
              {micSupported && (
                <button
                  type="button"
                  onClick={handleMicToggle}
                  disabled={isTyping}
                  aria-pressed={listening}
                  aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                  title={listening ? 'Stop dictation' : 'Dictate'}
                  className={`btn btn-secondary w-11 px-0 shrink-0
                    ${listening
                      ? 'bg-[var(--color-error)]/15 border-[var(--color-error)] text-[var(--color-error)] animate-pulse'
                      : ''
                    }`}
                >
                  <Icon name="mic" size={16} />
                </button>
              )}
              <button
                onClick={() => handleSend()}
                disabled={!input.trim() || isTyping}
                aria-label="Send message"
                className="btn btn-primary w-11 px-0 shrink-0"
              >
                <Icon name="send" size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Button: a 56px amber sign plate. Below md it sits 76px up (the
          62px tab bar plus 14px) so it never covers the bar's More tab (issue #249);
          the position lives in index.css (.fab). */}
      <button
        ref={fabRef}
        onClick={() => setOpen(!open)}
        className={`fab ${open ? 'is-open' : ''}`}
        aria-label="Campus Assistant"
        aria-expanded={open}
        title="Campus Assistant"
      >
        {open ? (
          <Icon name="close" size={22} />
        ) : (
          <Icon name="sparkles" size={24} />
        )}
      </button>
    </>
  )
}
