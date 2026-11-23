/** Farbschema pro Gerät: System, Hell oder Dunkel. Gespeichert im localStorage. */

export type Theme = 'system' | 'light' | 'dark';

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem('theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', theme);
  } catch {
    // Ohne Speicher gilt die Wahl nur bis zum Neuladen.
  }
}
