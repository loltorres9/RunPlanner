import { useEffect, useState, type FormEvent } from 'react';
import type { Language, Me } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { Icon } from './Icon.js';
import { LanguageSwitch } from './LanguageSwitch.js';

export function AuthScreen(props: {
  inviteCode: string | null;
  language: Language;
  onLanguage: (lang: Language) => void;
  onAuthenticated: (token: string, me: Me) => void;
}) {
  const { t, f } = useI18n();
  const [mode, setMode] = useState<'login' | 'register'>(props.inviteCode ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [groupName, setGroupName] = useState<string | null>(null);

  useEffect(() => {
    if (!props.inviteCode) return;
    api
      .invitePreview(props.inviteCode)
      .then((r) => setGroupName(r.groupName))
      .catch(() => setGroupName(null));
  }, [props.inviteCode]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'login'
          ? await api.login({ email, password })
          : await api.register({ email, name, password, language: props.language, inviteCode: groupName ? props.inviteCode : null });
      props.onAuthenticated(result.token, result.me);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card card">
        <div className="auth-head">
          <span className="logo">
            <Icon name="mountain" size={32} />
          </span>
          <h1>{t.appName}</h1>
          <p className="muted">{t.auth.tagline}</p>
        </div>
        {groupName && <p className="notice">{f(t.auth.invitedTo, { group: groupName })}</p>}
        <form onSubmit={submit} className="stack">
          {mode === 'register' && (
            <label>
              {t.auth.name}
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
            </label>
          )}
          <label>
            {t.auth.email}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            {t.auth.password}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 8 : undefined}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
            {mode === 'register' && <small className="muted">{t.auth.passwordHint}</small>}
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="primary" disabled={busy}>
            {mode === 'login' ? t.auth.login : t.auth.register}
          </button>
        </form>
        {mode === 'login' && <p className="muted small">{t.auth.forgot}</p>}
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? t.auth.toRegister : t.auth.toLogin}
        </button>
        <LanguageSwitch value={props.language} onChange={props.onLanguage} />
      </div>
    </div>
  );
}
