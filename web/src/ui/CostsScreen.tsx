import { useState } from 'react';
import { costsPerPerson } from '@runplanner/shared';
import { useI18n } from '../i18n/index.js';
import { todayIso, useApp } from '../state.js';

export function CostsScreen() {
  const { t, money } = useI18n();
  const { events } = useApp();
  const thisYear = todayIso().slice(0, 4);
  const years = [...new Set([thisYear, ...events.map((e) => e.startDate.slice(0, 4))])].sort();
  const [year, setYear] = useState(thisYear);
  const inYear = events.filter((e) => e.startDate.startsWith(year));
  const costs = costsPerPerson(inYear);
  const currency = inYear[0]?.currency ?? 'EUR';

  return (
    <div className="stack">
      <div className="row between">
        <h2>{t.costs.title}</h2>
        <select aria-label={t.costs.year} value={year} onChange={(e) => setYear(e.target.value)}>
          {years.map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </div>
      {costs.length === 0 ? (
        <p className="muted">{t.costs.empty}</p>
      ) : (
        <div className="card table-wrap">
          <table className="costs">
            <thead>
              <tr>
                <th>{t.costs.person}</th>
                <th className="optional-col">{t.costs.races}</th>
                <th>{t.costs.committed}</th>
                <th>{t.costs.open}</th>
                <th>{t.costs.planned}</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => (
                <tr key={c.userId}>
                  <td>{c.userName}</td>
                  <td className="optional-col">{c.races}</td>
                  <td>{money(c.committed, currency)}</td>
                  <td className={c.committed - c.paid > 0 ? 'warn-text' : ''}>{money(c.committed - c.paid, currency)}</td>
                  <td className="muted">{money(c.planned, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t.costs.hint}</p>
    </div>
  );
}
