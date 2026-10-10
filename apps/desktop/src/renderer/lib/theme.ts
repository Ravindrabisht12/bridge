export type Theme = 'light' | 'dark' | 'system'

const KEY = 'bridge.theme'

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    /* private mode / storage disabled */
  }
  return 'light'
}

export function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme
  document.documentElement.setAttribute('data-theme', resolved)
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* ignore */
  }
}

/** Keeps a 'system' choice in sync when the OS setting flips. */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!mq) return () => undefined
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
