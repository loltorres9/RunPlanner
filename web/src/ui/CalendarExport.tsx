/**
 * Angemeldete Strecken in den eigenen Kalender: Abo über einen geheimen Link oder
 * einmalig als .ics-Datei. Beides nutzt dieselben festen Kennungen, deshalb entstehen
 * beim wiederholten Abonnieren oder Importieren keine doppelten Termine.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';

export function CalendarExport() {
  const { t } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.calendarLink().then(
      (result) => setToken(result.token),
      (e) => setError(e instanceof ApiError ? e.message : t.common.error),
    );
  }, [t]);

  const httpsLink = token === null ? '' : `${window.location.origin}/api/calendar/${token}.ics`;
  const webcalLink = httpsLink.replace(/^https?:/, 'webcal:');

  async function copy() {
    await navigator.clipboard?.writeText(httpsLink).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function renew() {
    if (!window.confirm(t.calendarExport.renewConfirm)) return;
    setError(null);
    setMessage(null);
    try {
      setToken((await api.renewCalendarLink()).token);
      setMessage(t.calendarExport.renewed);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    }
  }

  return (
    <section className="card stack">
      <h2>{t.calendarExport.title}</h2>
      <p className="muted small">{t.calendarExport.hint}</p>
      {message && <p className="notice">{message}</p>}
      {error && <p className="error">{error}</p>}
      {token !== null && (
        <>
          <button type="button" className="primary" onClick={() => (window.location.href = webcalLink)}>
            {t.calendarExport.subscribe}
          </button>
          <p className="muted small">{t.calendarExport.subscribeHint}</p>
          <div className="row gap">
            <input readOnly value={httpsLink} aria-label={t.calendarExport.copy} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => void copy()}>
              {copied ? t.common.copied : t.calendarExport.copy}
            </button>
          </div>
          <p className="muted small">{t.calendarExport.delay}</p>
          <button type="button" onClick={() => (window.location.href = `${httpsLink}?download=1`)}>
            {t.calendarExport.download}
          </button>
          <p className="muted small">{t.calendarExport.downloadHint}</p>
          <p className="muted small">{t.calendarExport.secret}</p>
          <button type="button" className="small" onClick={() => void renew()}>
            {t.calendarExport.renew}
          </button>
        </>
      )}
    </section>
  );
}
