/** Kommentare unter einer Veranstaltung: Absprachen wie Fahrgemeinschaften. */

import { useEffect, useState, type FormEvent } from 'react';
import type { EventComment, RunEvent } from '@runplanner/shared';
import { api, ApiError } from '../api.js';
import { markCommentsSeen } from '../comments.js';
import { useI18n } from '../i18n/index.js';
import { useApp } from '../state.js';
import { initials } from './EventCard.js';
import { Icon } from './Icon.js';

export function CommentsSection(props: { event: RunEvent }) {
  const { t, ago } = useI18n();
  const { me, reloadEvents } = useApp();
  const { event } = props;
  const [comments, setComments] = useState<EventComment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Neu laden, wenn sich die Zahl oder der letzte Kommentar geändert hat.
  useEffect(() => {
    api.comments(event.id).then(setComments, () => setComments([]));
  }, [event.id, event.comments.count, event.comments.lastAt]);

  useEffect(() => {
    if (comments === null) return;
    markCommentsSeen(event.id, comments.length ? comments[comments.length - 1]!.createdAt : null);
  }, [comments, event.id]);

  async function run(action: () => Promise<EventComment[]>) {
    setBusy(true);
    setError(null);
    try {
      setComments(await action());
      // Damit Zähler in der Liste stimmen.
      void reloadEvents().catch(() => {});
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t.common.error);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await run(() => api.addComment(event.id, text))) setText('');
  }

  return (
    <section className="card stack comments">
      <h2>
        <Icon name="message" size={18} /> {t.comments.title}
      </h2>
      {comments === null && <p className="muted small">{t.common.loading}</p>}
      {comments?.length === 0 && <p className="muted small">{t.comments.empty}</p>}
      {comments && comments.length > 0 && (
        <ul className="comment-list">
          {comments.map((c) => (
            <li key={c.id} className={c.userId === me.user.id ? 'mine' : ''}>
              <span className="avatar">{initials(c.userName)}</span>
              <div className="comment-body">
                <div className="comment-head small">
                  <strong>{c.userName}</strong>
                  <span className="muted">{ago(c.createdAt)}</span>
                  {c.userId === me.user.id && (
                    <button
                      type="button"
                      className="link small"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t.comments.deleteConfirm)) void run(() => api.deleteComment(c.id));
                      }}
                    >
                      {t.common.delete}
                    </button>
                  )}
                </div>
                <p className="pre">{c.text}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="comment-form" onSubmit={send}>
        <textarea
          aria-label={t.comments.placeholder}
          placeholder={t.comments.placeholder}
          value={text}
          rows={2}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !text.trim()} aria-label={t.comments.send}>
          <Icon name="send" size={18} />
        </button>
      </form>
      <p className="muted small">{t.comments.hint}</p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
