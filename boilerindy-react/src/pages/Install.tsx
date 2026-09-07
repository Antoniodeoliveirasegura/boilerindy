import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icons'
import SiteDisclaimer from '../components/SiteDisclaimer'
import {
  INSTALL_NOTES,
  INSTALL_STEPS,
  PLATFORM_LABEL,
  detectInstallPlatform,
  readInstallEnv,
  type InstallPlatform,
} from '../lib/install'

// Public "add BoilerIndy to your phone" walkthrough (issue #9 follow-up).
// Picks the visitor's platform up front, offers the native install prompt
// where Chrome exposes one, and points installed visitors at Settings.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const PLATFORMS: InstallPlatform[] = ['ios', 'android', 'desktop']

export default function Install() {
  const [env] = useState(readInstallEnv)
  const [platform, setPlatform] = useState<InstallPlatform>(() => detectInstallPlatform(env))
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(env.isStandalone)

  // Chrome (Android and desktop) hands over a deferred prompt we can trigger
  // from a button; Safari never fires this, so the steps stay the fallback.
  useEffect(() => {
    function onBeforeInstall(event: Event) {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    function onInstalled() {
      setInstalled(true)
      setInstallPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  async function handleInstallNow() {
    if (!installPrompt) return
    try {
      await installPrompt.prompt()
      const choice = await installPrompt.userChoice
      if (choice.outcome === 'accepted') setInstalled(true)
    } catch {
      /* the browser declined to show the prompt; the manual steps remain */
    } finally {
      setInstallPrompt(null)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--color-bg-1)] px-6 py-12" data-testid="install-page">
      <div className="max-w-[720px] mx-auto">
        <Link to="/login" className="text-[13px] text-[var(--color-accent)] hover:underline">
          Back to sign in
        </Link>
        <h1 className="text-3xl font-bold text-[var(--color-txt-0)] mt-4 mb-2">Add BoilerIndy to your phone</h1>
        <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)] mb-6">
          BoilerIndy installs from the browser in under a minute: no app store, nothing to update. Once it
          is on your Home Screen it opens full screen, loads faster, and can send you deadline reminders.
        </p>

        {installed && (
          <div className="card p-4 mb-6 flex flex-wrap items-center gap-3" data-testid="install-done">
            <Icon name="check" size={16} className="text-[var(--color-success)]" />
            <span className="text-[13px] text-[var(--color-txt-0)]">You are already using the installed app.</span>
            <Link to="/settings" className="text-[13px] font-semibold text-[var(--color-accent)] hover:underline">
              Turn on notifications in Settings
            </Link>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-5" role="group" aria-label="Choose your device">
          {PLATFORMS.map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`install-tab-${key}`}
              aria-pressed={platform === key}
              onClick={() => setPlatform(key)}
              className={`text-[13px] font-medium px-3.5 py-1.5 rounded-lg border transition-colors ${
                platform === key
                  ? 'bg-[var(--color-gold)] text-[var(--color-gold-dark)] border-[var(--color-gold)]'
                  : 'bg-[var(--color-bg-0)] text-[var(--color-txt-1)] border-[var(--color-border)] hover:text-[var(--color-txt-0)]'
              }`}
            >
              {PLATFORM_LABEL[key]}
            </button>
          ))}
        </div>

        {installPrompt && platform !== 'ios' && !installed && (
          <div className="card p-4 mb-5 flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-[var(--color-txt-0)]">Your browser can install BoilerIndy right now.</span>
            <button
              type="button"
              data-testid="install-now"
              onClick={handleInstallNow}
              className="btn btn-primary text-[13px] px-4 py-2"
            >
              <Icon name="plus" size={14} />
              Install now
            </button>
          </div>
        )}

        <section className="card p-5" data-testid="install-steps">
          <h2 className="text-[17px] font-semibold text-[var(--color-txt-0)] mb-3">{PLATFORM_LABEL[platform]}</h2>
          <ol className="list-decimal pl-5 space-y-2.5">
            {INSTALL_STEPS[platform].map((step) => (
              <li key={step} className="text-[14px] leading-relaxed text-[var(--color-txt-1)]">
                {step}
              </li>
            ))}
          </ol>
          <p className="text-[13px] leading-relaxed text-[var(--color-txt-2)] mt-4 pt-4 border-t border-[var(--color-border)]">
            {INSTALL_NOTES[platform]}
          </p>
        </section>

        <p className="text-[13px] text-[var(--color-txt-2)] mt-6">
          Already installed it? Open BoilerIndy from its icon and head to{' '}
          <Link to="/settings" className="text-[var(--color-accent)] hover:underline">
            Settings
          </Link>{' '}
          to turn on notifications.
        </p>

        <SiteDisclaimer className="mt-8" />
      </div>
    </div>
  )
}
