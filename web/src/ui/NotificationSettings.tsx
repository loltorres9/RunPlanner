/** Benachrichtigungen: auf diesem Gerät ein/aus und was man gemeldet haben möchte. */

import { useEffect, useState } from 'react';
import { REMINDER_DAYS, type NotificationSettingsInput } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { disablePush, enablePush, pushState, type PushState } from '../push.js';
import { useApp } from '../state.js';

export function NotificationSettings() {
  const { t, f } = useI18n();
  const { me, setMe } = useApp();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = me.notifications;

  useEffect(() => {
    pushState().then(setState, () => setState('unsupported'));
  }, []);

  async function toggleDevice() {
    setBusy(true);
    setError(null);
    try {
      setState(state === 'on' ? await disablePush() : await enablePush());
    } catch (e) {
      setError(e instanceof Error && e.message === 'push_disabled' ? t.notify.serverOff : e instanceof ApiError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function update(input: NotificationSettingsInput) {
    setError(null);
    try {
      setMe(await api.updateMe({ notifications: input }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    }
  }

  const dayLabel = (days: number) => (days === 0 ? t.notify.never : days === 1 ? t.notify.dayBefore : f(t.notify.daysBefore, { count: days }));
  const stateText: Record<PushState, string> = {
    on: t.notify.on,
    off: t.notify.off,
    denied: t.notify.denied,
    'install-first': t.notify.installFirst,
    unsupported: t.notify.unsupported,
  };

  return (
    <section className="card stack notifications">
      <h2>{t.notify.title}</h2>
      <div className="stack gap-s">
        <span className="field-label">{t.notify.device}</span>
        {state !== null && <p className={`small ${state === 'on' ? '' : 'muted'}`}>{stateText[state]}</p>}
        {(state === 'on' || state === 'off') && (
          <button type="button" className={state === 'on' ? '' : 'primary'} disabled={busy} onClick={toggleDevice}>
            {state === 'on' ? t.notify.disable : t.notify.enable}
          </button>
        )}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={settings.newEvent} onChange={(e) => void update({ newEvent: e.target.checked })} />
        {t.notify.newEvent}
      </label>
      <label>
        {t.notify.deadline}
        <select value={settings.deadlineDays} onChange={(e) => void update({ deadlineDays: Number(e.target.value) })}>
          {REMINDER_DAYS.map((days) => (
            <option key={days} value={days}>
              {dayLabel(days)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.notify.event}
        <select value={settings.eventDays} onChange={(e) => void update({ eventDays: Number(e.target.value) })}>
          {REMINDER_DAYS.map((days) => (
            <option key={days} value={days}>
              {dayLabel(days)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{t.notify.hint}</p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
