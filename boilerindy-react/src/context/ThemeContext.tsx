import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

const STORAGE_KEY = 'pih-theme'
const LEGACY_KEY = 'pih-dark'

type Theme = 'light' | 'dark'

type ThemeContextValue = {
  theme: Theme
  dark: boolean
  setTheme: React.Dispatch<React.SetStateAction<Theme>>
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
    // Migrate the legacy forced-dark flag
    if (localStorage.getItem(LEGACY_KEY) === '1') return 'dark'
  } catch {
    /* storage unavailable */
  }
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light'
  return 'dark'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  const firstRun = useRef(true)

  useEffect(() => {
    const root = document.documentElement as HTMLElement & {
      _themeTransitionTimer?: number
    }

    // Crossfade colours on user-initiated switches (not on first paint),
    // unless the user prefers reduced motion.
    if (!firstRun.current) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (!reduce) {
        root.classList.add('theme-transition')
        window.clearTimeout(root._themeTransitionTimer)
        root._themeTransitionTimer = window.setTimeout(
          () => root.classList.remove('theme-transition'),
          450,
        )
      }
    }
    firstRun.current = false

    root.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, theme)
      localStorage.setItem(LEGACY_KEY, theme === 'dark' ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <ThemeContext.Provider value={{ theme, dark: theme === 'dark', setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
