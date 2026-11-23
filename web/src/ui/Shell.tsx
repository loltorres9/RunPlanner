import type { ReactNode } from 'react';
import { useI18n } from '../i18n/index.js';
import { navigate, useApp } from '../state.js';
import { Icon, type IconName } from './Icon.js';
import { UpdateBanner } from './UpdateBanner.js';

const TABS: { id: string; path: string; icon: IconName; label: 'calendar' | 'list' | 'costs' | 'group' | 'settings' }[] = [
  { id: 'calendar', path: '', icon: 'calendar', label: 'calendar' },
  { id: 'list', path: 'list', icon: 'list', label: 'list' },
  { id: 'costs', path: 'costs', icon: 'coins', label: 'costs' },
  { id: 'group', path: 'group', icon: 'users', label: 'group' },
  { id: 'settings', path: 'settings', icon: 'settings', label: 'settings' },
];

export function Shell(props: { tab: string; children: ReactNode }) {
  const { t } = useI18n();
  const { me, groupId, setGroupId } = useApp();
  const showFab = ['calendar', 'list'].includes(props.tab);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Icon name="mountain" />
          <span>{t.appName}</span>
        </div>
        {me.groups.length > 1 ? (
          <select
            className="group-switch"
            aria-label={t.group.switch}
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            {me.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="group-name">{me.groups.find((g) => g.id === groupId)?.name}</span>
        )}
      </header>

      <UpdateBanner />

      <main className="content">{props.children}</main>

      {showFab && (
        <button type="button" className="fab" aria-label={t.event.new} onClick={() => navigate('new')}>
          <Icon name="plus" />
        </button>
      )}

      <nav className="tabbar">
        {TABS.map((tab) => (
          <a
            key={tab.id}
            href={`#/${tab.path}`}
            className={props.tab === tab.id || (tab.id === 'list' && props.tab === 'event') ? 'active' : ''}
          >
            <Icon name={tab.icon} />
            <span>{t.nav[tab.label]}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
