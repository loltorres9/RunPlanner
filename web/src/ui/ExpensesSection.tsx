/**
 * Kosten teilen auf der Seite einer Veranstaltung: Wer hat was für wen bezahlt.
 * Die Abrechnung über alle Veranstaltungen steht im Tab „Kosten“.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { parseMoney, splitEqually, type Expense, type GroupDetail, type RunEvent } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { Icon } from './Icon.js';

type Member = GroupDetail['members'][number];

export function ExpensesSection(props: { event: RunEvent }) {
  const { t, f, money } = useI18n();
  const { me, putEvent } = useApp();
  const { event } = props;
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<GroupDetail | null>(null);
  // null = Formular zu, 'new' = neue Ausgabe, sonst die bearbeitete Ausgabe.
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);

  useEffect(() => {
    api.group(event.groupId).then(setGroup, () => setGroup(null));
  }, [event.groupId]);

  /** Speichern; Fehler gehen ans Formular zurück, damit es offen bleibt. */
  async function save(action: () => Promise<RunEvent>) {
    putEvent(await action());
    setEditing(null);
  }

  const cents = (value: number) => money(value / 100, event.currency);
  const total = event.expenses.reduce((sum, e) => sum + e.amountCents, 0);
  const canEdit = (e: Expense) => group?.role === 'admin' || e.paidBy === me.user.id || e.createdBy === me.user.id;

  return (
    <section className="card stack expenses">
      <h2>
        <Icon name="coins" size={18} /> {t.expenses.title}
      </h2>
      {event.expenses.length === 0 && editing === null && <p className="muted small">{t.expenses.empty}</p>}
      {event.expenses.length > 0 && (
        <ul className="expense-list">
          {event.expenses.map((e) =>
            editing !== 'new' && editing?.id === e.id && group ? (
              <li key={e.id}>
                <ExpenseForm
                  event={event}
                  members={group.members}
                  initial={e}
                  onCancel={() => setEditing(null)}
                  onSave={(input) => save(() => api.updateExpense(e.id, input))}
                />
              </li>
            ) : (
              <li key={e.id}>
                <div className="row between">
                  <strong>{e.description}</strong>
                  <strong>{cents(e.amountCents)}</strong>
                </div>
                <div className="muted small">
                  {f(t.expenses.line, { name: e.paidByName, amount: cents(e.amountCents) })} · {t.expenses.forWhom}:{' '}
                  {shareText(e, cents, t.expenses.each, f)}
                </div>
                {canEdit(e) && (
                  <div className="row gap small">
                    <button type="button" className="link small" onClick={() => setEditing(e)}>
                      {t.common.edit}
                    </button>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => {
                        if (window.confirm(f(t.expenses.deleteConfirm, { name: e.description }))) {
                          setError(null);
                          api.deleteExpense(e.id).then(putEvent, (err) =>
                            setError(err instanceof ApiError ? err.message : t.common.error),
                          );
                        }
                      }}
                    >
                      {t.common.delete}
                    </button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      {event.expenses.length > 1 && <p className="small">{f(t.expenses.total, { amount: cents(total) })}</p>}
      {editing === 'new' && group ? (
        <ExpenseForm
          event={event}
          members={group.members}
          onCancel={() => setEditing(null)}
          onSave={(input) => save(() => api.addExpense(event.id, input))}
        />
      ) : (
        <button type="button" onClick={() => setEditing('new')} disabled={!group}>
          <Icon name="plus" size={16} /> {t.expenses.add}
        </button>
      )}
    </section>
  );
}

function shareText(
  e: Expense,
  cents: (value: number) => string,
  each: string,
  f: (text: string, values: Record<string, string | number>) => string,
): string {
  const amounts = new Set(e.shares.map((s) => s.amountCents));
  // Gleich aufgeteilt (bis auf Rundungscent): Namen plus „je …“.
  if (Math.max(...amounts) - Math.min(...amounts) <= 1) {
    const names = e.shares.map((s) => s.userName).join(', ');
    return e.shares.length > 1 ? `${names} (${f(each, { amount: cents(e.shares[0]!.amountCents) })})` : names;
  }
  return e.shares.map((s) => `${s.userName} ${cents(s.amountCents)}`).join(', ');
}

/** Wer bei der Veranstaltung mitmacht; diese Personen sind beim Erfassen vorausgewählt. */
function participantIds(event: RunEvent): Set<string> {
  return new Set([
    ...event.races.flatMap((r) => r.participants.map((p) => p.userId)),
    ...event.stays.map((s) => s.userId),
  ]);
}

function centsToText(value: number): string {
  return (value / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
}

function ExpenseForm(props: {
  event: RunEvent;
  members: Member[];
  initial?: Expense;
  onCancel: () => void;
  onSave: (input: { paidBy: string; description: string; amountCents: number; shares: { userId: string; amountCents: number }[] }) => Promise<void>;
}) {
  const { t, f, money } = useI18n();
  const { me } = useApp();
  const { event, initial } = props;
  // Ehemalige Mitglieder einer bestehenden Ausgabe bleiben auswählbar.
  const people: { userId: string; name: string }[] = [
    ...props.members.map((m) => ({ userId: m.userId, name: m.name })),
    ...(initial?.shares ?? [])
      .filter((s) => !props.members.some((m) => m.userId === s.userId))
      .map((s) => ({ userId: s.userId, name: s.userName })),
  ];

  const [description, setDescription] = useState(initial?.description ?? '');
  const [amount, setAmount] = useState(initial ? centsToText(initial.amountCents) : '');
  const [paidBy, setPaidBy] = useState(initial?.paidBy ?? me.user.id);
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initial) return new Set(initial.shares.map((s) => s.userId));
    const participants = participantIds(event);
    // Noch niemand eingetragen: erst einmal alle der Gruppe.
    if (participants.size === 0) return new Set(people.map((p) => p.userId));
    participants.add(me.user.id);
    return new Set(people.filter((p) => participants.has(p.userId)).map((p) => p.userId));
  });
  const equal =
    !initial ||
    (() => {
      const split = splitEqually(initial.amountCents, initial.shares.map((s) => s.userId));
      return split.every((s, i) => s.amountCents === initial.shares[i]!.amountCents);
    })();
  const [custom, setCustom] = useState(!equal);
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial?.shares ?? []).map((s) => [s.userId, centsToText(s.amountCents)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const totalCents = parseMoney(amount);
  const chosen = people.filter((p) => selected.has(p.userId)).map((p) => p.userId);
  const shares = custom
    ? chosen.map((userId) => ({ userId, amountCents: parseMoney(customAmounts[userId] ?? '') ?? 0 }))
    : splitEqually(totalCents ?? 0, chosen);
  const rest = (totalCents ?? 0) - shares.reduce((sum, s) => sum + s.amountCents, 0);
  const cents = (value: number) => money(value / 100, event.currency);

  function toggle(userId: string) {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setSelected(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (totalCents === null || totalCents <= 0) return setError(t.expenses.invalidAmount);
    if (chosen.length === 0) return setError(t.expenses.nobody);
    if (rest !== 0) return setError(f(rest > 0 ? t.expenses.remaining : t.expenses.tooMuch, { amount: cents(Math.abs(rest)) }));
    setBusy(true);
    try {
      await props.onSave({ paidBy, description, amountCents: totalCents, shares });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack expense-form" onSubmit={submit}>
      <label>
        {t.expenses.what}
        <input
          required
          maxLength={200}
          value={description}
          placeholder={t.expenses.whatPlaceholder}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="row gap">
        <label className="grow">
          {t.expenses.amount} ({event.currency})
          <input inputMode="decimal" required value={amount} placeholder="0,00" onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="grow">
          {t.expenses.paidBy}
          <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="stack">
        <legend className="row between">
          <span>{t.expenses.forWhom}</span>
          <button
            type="button"
            className="link small"
            onClick={() => setSelected(selected.size === people.length ? new Set() : new Set(people.map((p) => p.userId)))}
          >
            {t.expenses.all}
          </button>
        </legend>
        {people.map((p) => {
          const share = shares.find((s) => s.userId === p.userId);
          return (
            <div key={p.userId} className="row between share-row">
              <label className="toggle">
                <input type="checkbox" checked={selected.has(p.userId)} onChange={() => toggle(p.userId)} /> {p.name}
              </label>
              {selected.has(p.userId) &&
                (custom ? (
                  <input
                    className="share-input"
                    inputMode="decimal"
                    aria-label={p.name}
                    value={customAmounts[p.userId] ?? ''}
                    placeholder="0,00"
                    onChange={(e) => setCustomAmounts({ ...customAmounts, [p.userId]: e.target.value })}
                  />
                ) : (
                  <span className="muted small">{cents(share?.amountCents ?? 0)}</span>
                ))}
            </div>
          );
        })}
        <label className="toggle small">
          <input
            type="checkbox"
            checked={custom}
            onChange={(e) => {
              if (e.target.checked) {
                // Mit der gleichmäßigen Aufteilung starten.
                setCustomAmounts(Object.fromEntries(shares.map((s) => [s.userId, centsToText(s.amountCents)])));
              }
              setCustom(e.target.checked);
            }}
          />{' '}
          {t.expenses.custom}
        </label>
        {custom && totalCents !== null && rest !== 0 && (
          <p className="warn-text small">
            {f(rest > 0 ? t.expenses.remaining : t.expenses.tooMuch, { amount: cents(Math.abs(rest)) })}
          </p>
        )}
      </fieldset>
      {error && <p className="error">{error}</p>}
      <div className="row gap">
        <button type="submit" className="primary" disabled={busy}>
          {t.common.save}
        </button>
        <button type="button" onClick={props.onCancel} disabled={busy}>
          {t.common.cancel}
        </button>
      </div>
    </form>
  );
}
