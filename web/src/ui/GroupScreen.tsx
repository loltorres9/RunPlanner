import { useCallback, useEffect, useState } from 'react';
import type { GroupDetail } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { navigate, useApp } from '../state.js';
import { initials } from './EventCard.js';

export function GroupScreen() {
  const { t, f } = useI18n();
  const { groupId, me, setMe } = useApp();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState('');

  const load = useCallback(() => {
    api
      .group(groupId)
      .then((g) => {
        setGroup(g);
        setName(g.name);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t.common.error));
  }, [groupId, t]);

  useEffect(load, [load]);

  if (!group) return <p className={error ? 'error' : 'muted'}>{error ?? t.common.loading}</p>;

  const isAdmin = group.role === 'admin';
  const link = `${window.location.origin}/#/join/${group.inviteCode}`;

  async function run(action: () => Promise<GroupDetail | void>) {
    setError(null);
    try {
      const result = await action();
      if (result) setGroup(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    }
  }

  async function share() {
    const text = `${t.appName}: ${group!.name}`;
    if (navigator.share) {
      await navigator.share({ title: text, url: link }).catch(() => {});
      return;
    }
    await navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function removeMember(userId: string, memberName: string) {
    const self = userId === me.user.id;
    if (!window.confirm(self ? t.group.leaveConfirm : f(t.group.removeConfirm, { name: memberName }))) return;
    await run(async () => {
      const next = await api.removeMember(group!.id, userId);
      if (self) {
        setMe(next);
        navigate('', true);
        return;
      }
      return api.group(group!.id);
    });
  }

  return (
    <div className="stack">
      {isAdmin ? (
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const g = await api.renameGroup(group.id, name);
              setMe(await api.me());
              return g;
            });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t.onboarding.groupName} required maxLength={80} />
          {name !== group.name && <button type="submit">{t.group.rename}</button>}
        </form>
      ) : (
        <h1>{group.name}</h1>
      )}

      {error && <p className="error">{error}</p>}

      <section className="card stack">
        <h2>{t.group.invite}</h2>
        <p className="muted small">{t.group.inviteHint}</p>
        <code className="invite-link">{link}</code>
        <div className="row gap wrap">
          <button type="button" className="primary" onClick={share}>
            {copied ? t.common.copied : t.common.share}
          </button>
          {isAdmin && (
            <button type="button" onClick={() => window.confirm(t.group.newCodeConfirm) && run(() => api.rotateInvite(group.id))}>
              {t.group.newCode}
            </button>
          )}
        </div>
      </section>

      <section className="card stack">
        <h2>{t.group.members}</h2>
        <ul className="members">
          {group.members.map((m) => (
            <li key={m.userId}>
              <span className="avatar">{initials(m.name)}</span>
              <span className="grow">
                {m.name}
                {m.userId === me.user.id && <span className="muted"> ({t.group.you})</span>}
                <br />
                <small className="muted">{m.role === 'admin' ? t.group.admin : t.group.member}</small>
              </span>
              {isAdmin && m.userId !== me.user.id && (
                <span className="row gap-s wrap end">
                  <button
                    type="button"
                    className="small"
                    onClick={() => run(() => api.setRole(group.id, m.userId, m.role === 'admin' ? 'member' : 'admin'))}
                  >
                    {m.role === 'admin' ? t.group.makeMember : t.group.makeAdmin}
                  </button>
                  <button type="button" className="small danger" onClick={() => removeMember(m.userId, m.name)}>
                    {t.group.remove}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="row gap wrap">
        <button type="button" onClick={() => navigate('add-group')}>
          {t.group.another}
        </button>
        <button type="button" className="danger" onClick={() => removeMember(me.user.id, me.user.name)}>
          {t.group.leave}
        </button>
      </div>
    </div>
  );
}
