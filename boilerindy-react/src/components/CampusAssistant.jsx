import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import Icon from './Icons'

const quickQuestions = [
  'What should I do right now?',
  "What's for lunch today?",
  "What's my next assignment due?",
  'What events are coming up?',
  'Is Tower Dining open now?',
]

export default function CampusAssistant() {
  const { getFirstName } = useAuth()
  const firstName = getFirstName()

  const [open, setOpen] = useState(false)
  // Each message: { role: 'user' | 'assistant', content: string }
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: `Hey ${firstName}! Ask me anything — e.g. what to do right now with your classes and homework, dining, buses, or where to study.`,
    },
  ])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [pendingMessage, setPendingMessage] = useState(null)
  const messagesRef = useRef(null)
  const inputRef = useRef(null)

  // Listen for external trigger (e.g. "Ask AI what to do" button on dashboard)
  useEffect(() => {
    const handler = (e) => {
      setOpen(true)
      if (e.detail?.message) setPendingMessage(e.detail.message)
    }
    window.addEventListener('open-campus-assistant', handler)
    return () => window.removeEventListener('open-campus-assistant', handler)
  }, [])

  // Fire pending message once the panel is open and messages state is fresh
  useEffect(() => {
    if (pendingMessage) {
      setPendingMessage(null)
      setTimeout(() => handleSend(pendingMessage), 200)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMessage])

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [messages, isTyping])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100)
  }, [open])

  async function handleSend(text = input) {
    const userMsg = text.trim()
    if (!userMsg || isTyping) return

    const nextMessages = [...messages, { role: 'user', content: userMsg }]
    setMessages(nextMessages)
    setInput('')
    setIsTyping(true)

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: nextMessages }),
      })
      const data = await res.json()
      const reply = data.reply || data.error || "Sorry, I couldn't get a response."
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

  function renderMessage(msg, idx) {
    const isUser = msg.role === 'user'
    return (
      <div
        key={idx}
        className={`flex gap-2.5 animate-fade-in-up ${isUser ? 'flex-row-reverse' : ''}`}
        style={{ animationDelay: `${idx * 0.03}s` }}
      >
        {!isUser && (
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0 mt-0.5">
            <Icon name="sparkles" size={14} className="text-[var(--color-gold-dark)]" />
          </div>
        )}
        <div
          className={`text-[13px] px-4 py-2.5 rounded-2xl max-w-[85%] leading-relaxed whitespace-pre-wrap
            ${isUser
              ? 'bg-gradient-to-br from-[var(--color-gold-dark)] to-[#2A1E0A] text-[var(--color-gold)] rounded-br-md'
              : 'bg-[var(--color-stat)] text-[var(--color-txt-0)] rounded-bl-md'
            }`}
        >
          {msg.content}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/20 backdrop-blur-sm z-40 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setOpen(false)}
      />

      {/* Chat Window */}
      <div className={`fixed bottom-24 right-6 z-50 w-[360px] max-w-[calc(100vw-48px)] transition-all duration-500 ease-out ${open ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-95 pointer-events-none'}`}>
        <div className="card p-0 overflow-hidden shadow-xl border-[var(--color-border-2)]">
          {/* Header */}
          <div className="bg-gradient-to-r from-[var(--color-gold-dark)] to-[#2A1E0A] p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[var(--color-gold)]/20 flex items-center justify-center">
                <Icon name="sparkles" size={20} className="text-[var(--color-gold)]" />
              </div>
              <div>
                <div className="text-[14px] font-semibold text-[var(--color-gold)]">IndyAssist</div>
                <div className="text-[11px] text-[var(--color-gold)]/60 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse" />
                  Powered by Gemini
                </div>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-8 h-8 rounded-lg bg-[var(--color-gold)]/10 flex items-center justify-center text-[var(--color-gold)]/70 hover:text-[var(--color-gold)] hover:bg-[var(--color-gold)]/20 transition-colors"
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          {/* Messages */}
          <div
            ref={messagesRef}
            className="min-h-[200px] max-h-[340px] overflow-y-auto p-4 space-y-3 bg-[var(--color-surface)]"
          >
            {messages.map(renderMessage)}

            {isTyping && (
              <div className="flex gap-2.5 animate-fade-in">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] flex items-center justify-center shrink-0">
                  <Icon name="sparkles" size={14} className="text-[var(--color-gold-dark)]" />
                </div>
                <div className="bg-[var(--color-stat)] rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-[var(--color-txt-3)] animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 rounded-full bg-[var(--color-txt-3)] animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 rounded-full bg-[var(--color-txt-3)] animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick Questions */}
          {messages.length <= 2 && !isTyping && (
            <div className="px-4 pb-3 flex flex-wrap gap-2 bg-[var(--color-surface)]">
              {quickQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(q)}
                  className="text-[11px] px-3 py-1.5 rounded-full border border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)] hover:text-[var(--color-txt-0)] transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t border-[var(--color-border)] bg-[var(--color-bg-1)]">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                placeholder="Ask about campus..."
                className="input flex-1 text-[13px] px-4 py-2.5"
                disabled={isTyping}
              />
              <button
                onClick={() => handleSend()}
                disabled={!input.trim() || isTyping}
                className="btn btn-primary px-4 py-2.5 disabled:opacity-50"
              >
                <Icon name="send" size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Button */}
      <button
        onClick={() => setOpen(!open)}
        className={`fixed bottom-6 right-6 z-50 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500 group
          ${open
            ? 'bg-[var(--color-surface)] border border-[var(--color-border-2)] rotate-90'
            : 'bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)] hover:shadow-xl hover:scale-110'
          }`}
        title="IndyAssist"
      >
        {open ? (
          <Icon name="close" size={22} className="text-[var(--color-txt-1)]" />
        ) : (
          <>
            <Icon name="sparkles" size={24} className="text-[var(--color-gold-dark)]" />
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-[var(--color-success)] border-2 border-[var(--color-bg-1)] animate-pulse" />
          </>
        )}
      </button>
    </>
  )
}
