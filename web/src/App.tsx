import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Language, Me, RunEvent } from '@runplanner/shared';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import { detectLanguage, I18nContext, makeI18n } from './i18n/index.js';
import { AppContext, navigate, storedGroupId, storeGroupId, useRoute, type AppState } from './state.js';
import { AuthScreen } from './ui/AuthScreen.js';
import { CalendarScreen } from './ui/CalendarScreen.js';
import { CostsScreen } from './ui/CostsScreen.js';
import { EventDetail } from './ui/EventDetail.js';
import { EventForm } from './ui/EventForm.js';
import { GroupScreen } from './ui/GroupScreen.js';
import { ListScreen } from './ui/ListScreen.js';
import { Onboarding } from './ui/Onboarding.js';
import { Shell } from './ui/Shell.js';
import { SettingsScreen } from './ui/SettingsScreen.js';

export function App() {
  const [me, setMeState] = useState<Me | null>(null);
  const [booting, setBooting] = useState(() => getToken() !== null);
  const [language, setLanguage] = useState<Language>(detectLanguage);
  const i18n = useMemo(() => makeI18n(language), [language]);
  const route = useRoute();

  const setMe = useCallback((next: Me) => {
    setMeState(next);
    setLanguage(next.user.language);
    try {
      localStorage.setItem('language', next.user.language);
    } catch {
      // egal
    }
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setMeState(null);
    navigate('', true);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (getToken() === null) return;
    api
      .me()
      .then(setMe)
      .catch(() => {})
      .finally(() => setBooting(false));
  }, [logout, setMe]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Einladungslinks: #/join/<code>
  const inviteCode = route[0] === 'join' ? (route[1] ?? null) : null;

  let content;
  if (booting) {
    content = <div className="center muted">{i18n.t.common.loading}</div>;
  } else if (me === null) {
    content = (
      <AuthScreen
        inviteCode={inviteCode}
        language={language}
        onLanguage={setLanguage}
        onAuthenticated={(token, next) => {
          setToken(token);
          setMe(next);
          const first = next.groups[0];
          if (first) storeGroupId(first.id);
          navigate('', true);
        }}
      />
    );
  } else {
    content = <SignedIn me={me} setMe={setMe} logout={logout} route={route} inviteCode={inviteCode} />;
  }

  return <I18nContext.Provider value={i18n}>{content}</I18nContext.Provider>;
}

function SignedIn(props: { me: Me; setMe: (me: Me) => void; logout: () => void; route: string[]; inviteCode: string | null }) {
  const { me, setMe, logout, route, inviteCode } = props;
  const [groupId, setGroupIdState] = useState<string | null>(() => {
    const stored = storedGroupId();
    return me.groups.some((g) => g.id === stored) ? stored : (me.groups[0]?.id ?? null);
  });
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [importEnabled, setImportEnabled] = useState(false);

  // Gruppe weg (verlassen/entfernt)? Dann auf die nächste ausweichen.
  useEffect(() => {
    if (groupId === null || !me.groups.some((g) => g.id === groupId)) {
      setGroupIdState(me.groups[0]?.id ?? null);
    }
  }, [me, groupId]);

  const setGroupId = useCallback((id: string) => {
    storeGroupId(id);
    setGroupIdState(id);
  }, []);

  const reloadEvents = useCallback(async () => {
    if (groupId === null) return;
    const result = await api.events(groupId);
    setEvents(result.events);
    setEventsLoaded(true);
  }, [groupId]);

  useEffect(() => {
    setEvents([]);
    setEventsLoaded(false);
    reloadEvents().catch(() => setEventsLoaded(true));
  }, [reloadEvents]);

  // Beim Zurückkehren in die App aktualisieren, damit Änderungen der anderen auftauchen.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reloadEvents().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reloadEvents]);

  useEffect(() => {
    api.config().then((c) => setImportEnabled(c.importEnabled)).catch(() => {});
  }, []);

  if (groupId === null || inviteCode !== null) {
    return (
      <Onboarding
        me={me}
        inviteCode={inviteCode}
        onDone={(next, id) => {
          setMe(next);
          setGroupId(id);
          navigate('', true);
        }}
        onLogout={logout}
      />
    );
  }

  const state: AppState = {
    me,
    setMe,
    groupId,
    setGroupId,
    events,
    eventsLoaded,
    reloadEvents,
    putEvent: (event) =>
      setEvents((list) => {
        const rest = list.filter((e) => e.id !== event.id);
        return [...rest, event].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name));
      }),
    dropEvent: (id) => setEvents((list) => list.filter((e) => e.id !== id)),
    importEnabled,
    logout,
  };

  const [page, id, action] = route;
  let screen;
  let tab: string = page ?? 'calendar';
  if (page === 'new') screen = <EventForm />;
  else if (page === 'event' && id && action === 'edit') screen = <EventForm eventId={id} />;
  else if (page === 'event' && id) screen = <EventDetail eventId={id} />;
  else if (page === 'list') screen = <ListScreen />;
  else if (page === 'costs') screen = <CostsScreen />;
  else if (page === 'group') screen = <GroupScreen />;
  else if (page === 'settings') screen = <SettingsScreen />;
  else if (page === 'add-group') {
    return (
      <Onboarding
        me={me}
        inviteCode={null}
        onDone={(next, newId) => {
          setMe(next);
          setGroupId(newId);
          navigate('', true);
        }}
        onCancel={() => navigate('group')}
        onLogout={logout}
      />
    );
  } else {
    screen = <CalendarScreen month={id} />;
    tab = 'calendar';
  }

  return (
    <AppContext.Provider value={state}>
      <Shell tab={tab}>{screen}</Shell>
    </AppContext.Provider>
  );
}
