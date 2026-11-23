/**
 * „Wer schuldet wem“ im Tab Kosten: Ausgaben aller Veranstaltungen der Gruppe,
 * verrechnet zu möglichst wenigen Überweisungen. „Erledigt“ hält eine Zahlung fest.
 */

import { useEffect, useState } from 'react';
import { settleUp, type Settlement, type Transfer } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { Icon } from './Icon.js';

export function SettleUp() {
  const { t, f, money, date } = useI18n();
  const { events, groupId, me } = useApp();
  const [settlements, setSettlements] = useState<Settlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    setSettlements(null);
    api.settlements(groupId).then(setSettlements, () => setSettlements([]));
  }, [groupId]);

  const expenses = events.flatMap((e) => e.expenses);
  const transfers = settlements ? settleUp(expenses, settlements) : [];
  const cents = (value: number, currency: string) => money(value / 100, currency);
  const name = (userId: string, userName: string) => (userId === me.user.id ? t.expenses.you : userName);
  const eventName = new Map(events.map((e) => [e.id, e.name]));

  async function run(action: () => Promise<Settlement[]>) {
    setBusy(true);
    setError(null);
    try {
      setSettlements(await action());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  function markDone(transfer: Transfer) {
    const text = f(t.expenses.doneConfirm, {
      from: transfer.fromName,
      to: transfer.toName,
      amount: cents(transfer.amountCents, transfer.currency),
    });
    if (!window.confirm(text)) return;
    void run(() =>
      api.addSettlement(groupId, {
        fromUser: transfer.from,
        toUser: transfer.to,
        amountCents: transfer.amountCents,
        currency: transfer.currency,
      }),
    );
  }

  return (
    <section className="card stack settle">
      <h2>{t.expenses.settleTitle}</h2>
      {settlements === null && <p className="muted small">{t.common.loading}</p>}
      {settlements !== null && expenses.length === 0 && settlements.length === 0 && (
        <p className="muted small">{t.expenses.noExpenses}</p>
      )}
      {settlements !== null && (expenses.length > 0 || settlements.length > 0) && transfers.length === 0 && (
        <p className="ok-text">{t.expenses.settled}</p>
      )}
      {transfers.length > 0 && (
        <ul className="transfer-list">
          {transfers.map((tr) => (
            <li key={`${tr.currency}:${tr.from}:${tr.to}`} className={tr.from === me.user.id || tr.to === me.user.id ? 'mine' : ''}>
              <span className="transfer-names">
                <strong>{name(tr.from, tr.fromName)}</strong> → <strong>{name(tr.to, tr.toName)}</strong>
              </span>
              <strong className="transfer-amount">{cents(tr.amountCents, tr.currency)}</strong>
              <button type="button" className="small" disabled={busy} onClick={() => markDone(tr)}>
                {t.expenses.done}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      {transfers.length > 0 && <p className="muted small">{t.expenses.settleHint}</p>}

      {expenses.length > 0 && (
        <details>
          <summary>
            {t.expenses.allExpenses} ({expenses.length})
          </summary>
          <ul className="expense-overview">
            {[...expenses]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((e) => (
                <li key={e.id}>
                  <a href={`#/event/${e.eventId}`}>{eventName.get(e.eventId)}</a>
                  <span>
                    {e.description} · {e.paidByName}
                  </span>
                  <strong>{cents(e.amountCents, e.currency)}</strong>
                </li>
              ))}
          </ul>
        </details>
      )}

      {settlements !== null && settlements.length > 0 && (
        <details open={showHistory} onToggle={(e) => setShowHistory((e.target as HTMLDetailsElement).open)}>
          <summary>
            {t.expenses.history} ({settlements.length})
          </summary>
          <ul className="expense-overview">
            {settlements.map((s) => (
              <li key={s.id}>
                <span className="muted small">{date(new Date(s.createdAt).toISOString().slice(0, 10))}</span>
                <span>
                  {name(s.fromUser, s.fromName)} → {name(s.toUser, s.toName)}
                </span>
                <strong>{cents(s.amountCents, s.currency)}</strong>
                <button
                  type="button"
                  className="link small"
                  disabled={busy}
                  aria-label={t.expenses.undo}
                  onClick={() => {
                    if (window.confirm(t.expenses.undoConfirm)) void run(() => api.deleteSettlement(s.id));
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
