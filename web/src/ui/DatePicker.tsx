/**
 * Datumsfeld mit eigenem Kalenderdialog, im Stil der Kalenderansicht.
 *
 * Zeitraum: erster Klick = Start, zweiter Klick = Ende, der Dialog schließt sich dann
 * von selbst. Zweimal derselbe Tag = Eintagesveranstaltung. Einzeltag: ein Klick genügt.
 */

import { useEffect, useRef, useState } from 'react';
import { monthGrid, rangeClick, shiftMonth } from '../dates.js';
import { useI18n } from '../i18n/index.js';
import { todayIso } from '../state.js';
import { Icon } from './Icon.js';

interface RangeProps {
  mode: 'range';
  label: string;
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  invalid?: boolean;
}

interface SingleProps {
  mode: 'single';
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function DateField(props: RangeProps | SingleProps) {
  const { t, date } = useI18n();
  const [open, setOpen] = useState(false);
  let text = '';
  if (props.mode === 'range' && props.start) {
    // Gleiches Jahr: Jahr nur einmal am Ende, damit es auf dem Handy in eine Zeile passt.
    const sameYear = props.end && props.end.slice(0, 4) === props.start.slice(0, 4);
    const first = sameYear ? date(props.start, { weekday: 'short', day: 'numeric', month: 'short' }) : date(props.start);
    text = props.end ? `${first} – ${date(props.end)}` : date(props.start);
  } else if (props.mode === 'single' && props.value) {
    text = date(props.value);
  }
  const hasValue = text !== '';

  return (
    <div className="date-field">
      <span className="field-label">{props.label}</span>
      <div className="row gap-s">
        <button
          type="button"
          className={`date-button${props.mode === 'range' && props.invalid ? ' invalid' : ''}`}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <Icon name="calendar" size={18} />
          <span className={hasValue ? '' : 'muted'}>{hasValue ? text : t.event.pickDate}</span>
        </button>
        {props.mode === 'single' && hasValue && (
          <button type="button" className="icon-button" aria-label={t.event.clearDate} onClick={() => props.onChange('')}>
            ✕
          </button>
        )}
      </div>
      {open && <CalendarDialog {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CalendarDialog(props: (RangeProps | SingleProps) & { onClose: () => void }) {
  const { t, date } = useI18n();
  const today = todayIso();
  const initial = props.mode === 'range' ? props.start : props.value;
  const [month, setMonth] = useState((initial || today).slice(0, 7));
  const [pending, setPending] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Was markiert wird: während der Auswahl nur der neue Start, sonst der gespeicherte Wert.
  let selStart = '';
  let selEnd = '';
  if (pending !== null) {
    selStart = pending;
    selEnd = pending;
  } else if (props.mode === 'range') {
    selStart = props.start;
    selEnd = props.end || props.start;
  } else {
    selStart = props.value;
    selEnd = props.value;
  }

  function pick(day: string) {
    if (props.mode === 'single') {
      props.onChange(day);
      props.onClose();
      return;
    }
    const result = rangeClick(pending, day);
    if (result.kind === 'pending') {
      setPending(result.start);
      if (!result.start.startsWith(month)) setMonth(result.start.slice(0, 7));
      return;
    }
    props.onChange(result.start, result.end ?? '');
    props.onClose();
  }

  const hint =
    props.mode === 'single' ? props.label : pending === null ? t.event.pickStart : t.event.pickEnd;

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        className="dialog card stack"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row between">
          <button type="button" className="icon-button" aria-label={t.calendar.prev} onClick={() => setMonth(shiftMonth(month, -1))}>
            <Icon name="chevronLeft" />
          </button>
          <h2 className="capitalize">{date(`${month}-01`, { month: 'long', year: 'numeric' })}</h2>
          <button type="button" className="icon-button" aria-label={t.calendar.next} onClick={() => setMonth(shiftMonth(month, 1))}>
            <Icon name="chevronRight" />
          </button>
        </div>
        <p className="muted small center-text" aria-live="polite">
          {hint}
        </p>
        <div className="picker-grid" role="grid">
          {monthGrid(month)
            .slice(0, 7)
            .map((d) => (
              <span key={`h${d}`} className="weekday">
                {date(d, { weekday: 'narrow' })}
              </span>
            ))}
          {monthGrid(month).map((day) => {
            const classes = ['pick-day'];
            if (!day.startsWith(month)) classes.push('other');
            if (day === today) classes.push('today');
            if (selStart && day >= selStart && day <= selEnd) classes.push('in-range');
            if (day === selStart) classes.push('range-start');
            if (day === selEnd) classes.push('range-end');
            return (
              <button
                key={day}
                type="button"
                className={classes.join(' ')}
                aria-pressed={day >= selStart && day <= selEnd}
                aria-label={date(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                onClick={() => pick(day)}
              >
                {Number(day.slice(8))}
              </button>
            );
          })}
        </div>
        <div className="row between">
          <button type="button" className="link" onClick={() => setMonth(today.slice(0, 7))}>
            {t.calendar.today}
          </button>
          <button type="button" className="link" onClick={props.onClose}>
            {t.common.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
