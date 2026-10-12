import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icons'
import SiteDisclaimer from '../components/SiteDisclaimer'
import BrandMark from '../components/BrandMark'
import {
  INSTALL_NOTES,
  INSTALL_STEPS,
  PLATFORM_LABEL,
  detectInstallPlatform,
  readInstallEnv,
  type InstallPlatform,
} from '../lib/install'
import PageTitle from '../components/PageTitle'

// Public "add BoilerIndy to your phone" walkthrough (issue #9 follow-up).
// Picks the visitor's platform up front, offers the native install prompt
// where Chrome exposes one, and points installed visitors at Settings.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const PLATFORMS: InstallPlatform[] = ['ios', 'android', 'desktop']

// Phones install to the Home Screen; a computer gets its own window.
const PLATFORM_ICON: Record<InstallPlatform, string> = {
  ios: 'home',
  android: 'home',
  desktop: 'laptop',
}

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
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-1)]" data-testid="install-page">
      <PageTitle>Install the app</PageTitle>
      <div className="page flex-1 pb-12 md:pb-16">
        <div className="page-measure">
          <div className="mb-8 flex items-center gap-3 md:mb-10">
            <BrandMark size={28} />
            <span aria-hidden="true" className="h-6 w-px bg-[var(--color-border-2)]" />
            <Link
              to="/login"
              className="-ml-1 inline-flex min-h-11 items-center rounded-[var(--radius-md)] px-2 font-display text-[13px] font-bold text-[var(--color-txt-2)] no-underline hover:text-[var(--color-txt-0)]"
            >
              {/* The same text arrow the sibling pages carry in their back
                  label; decorative here, so the link's name is unchanged. */}
              <span aria-hidden="true">←&nbsp;</span>
              Back to sign in
            </Link>
          </div>
          <div className="page-head">
            <div>
              <h1 className="page-title">Add BoilerIndy to your phone</h1>
              <p className="page-sub">
                BoilerIndy installs from the browser in under a minute: no app store, nothing to update. Once it
                is on your Home Screen it opens full screen, loads faster, and can send you deadline reminders.
              </p>
            </div>
          </div>

          {installed && (
            <div className="card mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-4 pr-3" data-testid="install-done">
              <span aria-hidden="true" className="route-badge sm bg-[var(--color-success)] text-[var(--color-on-route)]">
                <Icon name="check" />
              </span>
              <span className="text-[14px] text-[var(--color-txt-0)]">You are already using the installed app.</span>
              <Link to="/settings" className="head-link">
                Turn on notifications in Settings
              </Link>
            </div>
          )}

          <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Choose your device">
            {PLATFORMS.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`install-tab-${key}`}
                aria-pressed={platform === key}
                onClick={() => setPlatform(key)}
                className={`pill ${platform === key ? 'pill-active' : ''}`}
              >
                {PLATFORM_LABEL[key]}
              </button>
            ))}
          </div>

          {installPrompt && platform !== 'ios' && !installed && (
            <div className="card mb-4 flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="text-[14px] text-[var(--color-txt-0)]">Your browser can install BoilerIndy right now.</span>
              <button
                type="button"
                data-testid="install-now"
                onClick={handleInstallNow}
                className="btn btn-primary btn-sm ml-auto"
              >
                <Icon name="plus" size={14} />
                Install now
              </button>
            </div>
          )}

          <section
            className="card card-pad r-ink -mx-4 rounded-none border-x-0 sm:mx-0 sm:rounded-[var(--radius-xl)] sm:border-x sm:p-8"
            data-testid="install-steps"
          >
            <header className="card-head mb-6">
              <span aria-hidden="true" className="route-badge">
                <Icon name={PLATFORM_ICON[platform]} />
              </span>
              <div>
                <h2 className="card-title text-[18px]">{PLATFORM_LABEL[platform]}</h2>
              </div>
            </header>
            {/* The steps as stops on a line: numbered squares joined by a rule.
                role="list" keeps the list semantics Safari drops once
                list-style is none; the visible numbers are decorative. */}
            <ol role="list">
              {INSTALL_STEPS[platform].map((step, index, steps) => (
                <li key={step} className="relative pb-6 pl-10 last:pb-0 sm:pl-12">
                  <span
                    aria-hidden="true"
                    className="route-badge sm absolute left-0 top-0 font-display text-[12px] font-extrabold tnum"
                  >
                    {index + 1}
                  </span>
                  {index < steps.length - 1 ? (
                    <span aria-hidden="true" className="absolute bottom-1 left-[11px] top-7 w-0.5 bg-[var(--route)]" />
                  ) : null}
                  <span className="block text-[15px] leading-[1.6] text-[var(--color-txt-1)]">{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 border-t border-[var(--color-border)] pt-4 text-[14px] leading-relaxed text-[var(--color-txt-2)]">
              {INSTALL_NOTES[platform]}
            </p>
          </section>

          <p className="mt-6 text-[14px] leading-relaxed text-[var(--color-txt-2)]">
            Already installed it? Open BoilerIndy from its icon and head to{' '}
            <Link
              to="/settings"
              className="font-semibold text-[var(--color-accent)] underline decoration-[var(--color-accent)]/45 decoration-[1.5px] underline-offset-[3px] hover:decoration-[var(--color-accent)]"
            >
              Settings
            </Link>{' '}
            to turn on notifications.
          </p>
        </div>
      </div>

      <SiteDisclaimer rule />
    </div>
  )
}
