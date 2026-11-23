/** Neuigkeiten: was sich in welcher Version geändert hat, in der Sprache der Person. */

import { useEffect } from 'react';
import { CHANGELOG } from '../changelog.js';
import { useI18n } from '../i18n/index.js';
import { APP_VERSION } from '../version.js';
import { Icon } from './Icon.js';
import { markVersionSeen } from './UpdateBanner.js';

export function ChangelogScreen() {
  const { t, f, date, lang } = useI18n();
  // Die Einstellungen sind meist nach unten gescrollt; die Neuigkeiten beginnen oben.
  useEffect(() => {
    window.scrollTo(0, 0);
    markVersionSeen();
  }, []);
  return (
    <div className="stack changelog">
      <button type="button" className="link back" onClick={() => window.history.back()}>
        <Icon name="chevronLeft" size={16} /> {t.common.back}
      </button>
      <h1>{t.settings.changelog}</h1>
      {CHANGELOG.map((entry) => (
        <section key={entry.version} className="card stack">
          <div className="row between wrap gap-s">
            <h2>
              {f(t.settings.version, { version: entry.version })}
              {entry.version === APP_VERSION && <span className="badge new">{t.settings.current}</span>}
            </h2>
            <span className="muted small">{date(entry.date)}</span>
          </div>
          <ul>
            {entry[lang].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
