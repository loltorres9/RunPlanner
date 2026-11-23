import { useEffect, useState, type FormEvent } from 'react';
import type { Me } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';

/** Aus einem Einladungslink oder einem nackten Code den Code herauslösen. */
export function extractInviteCode(value: string): string {
  const trimmed = value.trim();
  const match = /#\/join\/([^/?#\s]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export function Onboarding(props: {
  me: Me;
  inviteCode: string | null;
  onDone: (me: Me, groupId: string) => void;
  onCancel?: () => void;
  onLogout: () => void;
}) {
  const { t, f } = useI18n();
  const [groupName, setGroupName] = useState('');
  const [code, setCode] = useState(props.inviteCode ?? '');
  const [invitedTo, setInvitedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.inviteCode) return;
    api
      .invitePreview(props.inviteCode)
      .then((r) => setInvitedTo(r.groupName))
      .catch((e) => setError(e instanceof ApiError ? e.message : t.common.error));
  }, [props.inviteCode, t]);

  async function run(action: () => Promise<{ me: Me; groupId: string }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      props.onDone(result.me, result.groupId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const group = await api.createGroup(groupName);
      return { me: await api.me(), groupId: group.id };
    });
  }

  function join(event: FormEvent) {
    event.preventDefault();
    void run(() => api.joinGroup(extractInviteCode(code)));
  }

  return (
    <div className="auth">
      <div className="auth-card card stack">
        <h1>{t.onboarding.title}</h1>
        {invitedTo ? <p className="notice">{f(t.auth.invitedTo, { group: invitedTo })}</p> : <p className="muted">{t.onboarding.intro}</p>}
        {error && <p className="error">{error}</p>}

        <form onSubmit={join} className="stack">
          <h2>{t.onboarding.joinTitle}</h2>
          {!props.inviteCode && <p className="muted small">{t.onboarding.joinHint}</p>}
          <label>
            {t.onboarding.inviteCode}
            <input value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <button type="submit" className={props.inviteCode ? 'primary' : ''} disabled={busy}>
            {t.onboarding.join}
          </button>
        </form>

        {!props.inviteCode && (
          <form onSubmit={create} className="stack">
            <h2>{t.onboarding.createTitle}</h2>
            <label>
              {t.onboarding.groupName}
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={t.onboarding.groupNamePlaceholder}
                required
                maxLength={80}
              />
            </label>
            <button type="submit" className="primary" disabled={busy}>
              {t.onboarding.create}
            </button>
          </form>
        )}

        <div className="row between">
          {props.onCancel || (props.inviteCode && props.me.groups.length > 0) ? (
            <button type="button" className="link" onClick={props.onCancel ?? (() => (window.location.hash = '#/'))}>
              {t.common.back}
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="link" onClick={props.onLogout}>
            {t.settings.logout}
          </button>
        </div>
      </div>
    </div>
  );
}
