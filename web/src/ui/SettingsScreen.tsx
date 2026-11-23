import { useState, type FormEvent } from 'react';
import { api, ApiError, setToken } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { APP_BUILT, APP_COMMIT, APP_VERSION } from '../version.js';
import { LanguageSwitch } from './LanguageSwitch.js';
import { applyTheme, storedTheme, type Theme } from '../theme.js';

export function SettingsScreen() {
  const { t, f, date } = useI18n();
  const { me, setMe, logout } = useApp();
  const [name, setName] = useState(me.user.name);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [theme, setTheme] = useState<Theme>(storedTheme);

  async function run(action: () => Promise<void>, success: string) {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(success);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    }
  }

  function saveName(event: FormEvent) {
    event.preventDefault();
    void run(async () => setMe(await api.updateMe({ name })), t.settings.saved);
  }

  function changePassword(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await api.changePassword({ currentPassword, newPassword });
      setToken(result.token);
      setCurrentPassword('');
      setNewPassword('');
    }, t.settings.passwordChanged);
  }

  return (
    <div className="stack">
      <h1>{t.settings.title}</h1>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}

      <section className="card stack">
        <h2>{t.settings.profile}</h2>
        <p className="muted small">{me.user.email}</p>
        <form className="row gap" onSubmit={saveName}>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t.auth.name} required maxLength={80} />
          {name !== me.user.name && <button type="submit">{t.common.save}</button>}
        </form>
      </section>

      <section className="card stack">
        <h2>{t.settings.language}</h2>
        <LanguageSwitch value={me.user.language} onChange={(language) => void run(async () => setMe(await api.updateMe({ language })), '')} />
      </section>

      <section className="card stack">
        <h2>{t.settings.theme}</h2>
        <div className="segmented" role="group" aria-label={t.settings.theme}>
          {(['system', 'light', 'dark'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={theme === value ? 'active' : ''}
              aria-pressed={theme === value}
              onClick={() => {
                setTheme(value);
                applyTheme(value);
              }}
            >
              {t.settings.themes[value]}
            </button>
          ))}
        </div>
      </section>

      <section className="card stack">
        <h2>{t.settings.install}</h2>
        <p className="muted small">{t.settings.installHint}</p>
      </section>

      <form className="card stack" onSubmit={changePassword}>
        <h2>{t.settings.changePassword}</h2>
        <label>
          {t.settings.currentPassword}
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        <label>
          {t.settings.newPassword}
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <button type="submit">{t.settings.changePassword}</button>
      </form>

      <button type="button" className="danger" onClick={logout}>
        {t.settings.logout}
      </button>

      <p className="muted small version">
        {f(t.settings.version, { version: APP_VERSION })}
        {APP_COMMIT && ` (${APP_COMMIT})`} · {date(APP_BUILT)}
      </p>
    </div>
  );
}
