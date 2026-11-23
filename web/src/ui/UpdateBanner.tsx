/**
 * Hinweis nach einem Update: Läuft eine neuere Version als beim letzten Mal, steht oben
 * ein Banner. Ein Tipp öffnet die Neuigkeiten, das X blendet ihn aus. Beim allerersten
 * Start gibt es keinen Hinweis.
 */

import { useState } from 'react';
import { useI18n } from '../i18n/index.js';
import { navigate } from '../state.js';
import { APP_VERSION } from '../version.js';
import { Icon } from './Icon.js';

const KEY = 'seenVersion';

function readSeen(): string | null {
  try {
    const seen = localStorage.getItem(KEY);
    if (seen === null) localStorage.setItem(KEY, APP_VERSION);
    return seen ?? APP_VERSION;
  } catch {
    return APP_VERSION;
  }
}

export function markVersionSeen(): void {
  try {
    localStorage.setItem(KEY, APP_VERSION);
  } catch {
    // egal
  }
}

export function UpdateBanner() {
  const { t, f } = useI18n();
  const [visible, setVisible] = useState(() => readSeen() !== APP_VERSION);
  if (!visible) return null;

  function close() {
    markVersionSeen();
    setVisible(false);
  }

  return (
    <div className="update-banner" role="status">
      <button
        type="button"
        className="update-open"
        onClick={() => {
          close();
          navigate('changelog');
        }}
      >
        <Icon name="sparkle" size={16} /> {f(t.update.banner, { version: APP_VERSION })}
      </button>
      <button type="button" className="update-close" aria-label={t.update.dismiss} onClick={close}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
