import { createContext, useContext, useEffect, useState } from 'react'

const STORAGE_KEY = 'pih-theme'
const LEGACY_KEY = 'pih-dark'

const ThemeContext = createContext()

function getInitialTheme() {
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

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(getInitialTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
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
export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
