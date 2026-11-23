/** Seite hinter dem Reset-Link, den ein Admin erzeugt hat: neues Passwort setzen. */

import { useEffect, useState, type FormEvent } from 'react';
import type { Me } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { navigate } from '../state.js';
import { Icon } from './Icon.js';

export function ResetScreen(props: { code: string; onDone: (token: string, me: Me) => void }) {
  const { t, f } = useI18n();
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .resetPreview(props.code)
      .then((r) => setName(r.name))
      .catch((e) => setError(e instanceof ApiError ? e.message : t.common.error));
  }, [props.code, t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.resetPassword(props.code, password);
      props.onDone(result.token, result.me);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card card stack">
        <div className="auth-head">
          <span className="logo">
            <Icon name="mountain" size={32} />
          </span>
          <h1>{t.reset.title}</h1>
        </div>
        {name !== null && (
          <form onSubmit={submit} className="stack">
            <p>{f(t.reset.intro, { name })}</p>
            <label>
              {t.settings.newPassword}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <small className="muted">{t.auth.passwordHint}</small>
            </label>
            <button type="submit" className="primary" disabled={busy}>
              {t.reset.save}
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
        <button type="button" className="link" onClick={() => navigate('', true)}>
          {t.reset.toLogin}
        </button>
      </div>
    </div>
  );
}
