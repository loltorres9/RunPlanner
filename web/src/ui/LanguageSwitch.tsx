import type { Language } from '@runplanner/shared';

export function LanguageSwitch(props: { value: Language; onChange: (lang: Language) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Sprache / Language">
      {(['de', 'en'] as const).map((lang) => (
        <button
          key={lang}
          type="button"
          className={props.value === lang ? 'active' : ''}
          aria-pressed={props.value === lang}
          onClick={() => props.onChange(lang)}
        >
          {lang === 'de' ? 'Deutsch' : 'English'}
        </button>
      ))}
    </div>
  );
}
