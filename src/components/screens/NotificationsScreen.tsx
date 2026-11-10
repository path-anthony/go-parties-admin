import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NOTIFICATIONS_CHANGED, getNotifications, markAllNotificationsRead, markNotificationRead } from "../../lib/api";
import { notificationWhen } from "../../lib/notifications";
import type { NotificationList, NotificationRow } from "../../lib/types";

const PAGE_SIZE = 25;

// The full list behind the bell, unread first, with a filter by type.
export function NotificationsScreen() {
  const [data, setData] = useState<NotificationList | null>(null);
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Only the newest question may fill the list: flipping the filter quickly
  // must not let a slower, older answer land on top.
  const latest = useRef(0);
  const load = useCallback(() => {
    const asked = ++latest.current;
    getNotifications({ page, limit: PAGE_SIZE, type: type || undefined })
      .then((r) => {
        if (asked !== latest.current) return;
        setData(r);
        setError(null);
      })
      .catch((err) => {
        if (asked === latest.current) setError(err instanceof Error ? err.message : "Couldn't load notifications");
      });
  }, [page, type]);

  useEffect(() => {
    load();
    window.addEventListener(NOTIFICATIONS_CHANGED, load);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, load);
  }, [load]);

  async function readAll() {
    try {
      await markAllNotificationsRead();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    }
  }

  const open = (row: NotificationRow) => {
    if (!row.readAt) markNotificationRead(row.id).catch(() => undefined);
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Notifications</h2>
        <p className="muted">{data ? `${data.unread} unread` : "Loading."}</p>
      </div>
      <section className="panel">
        <div className="filter-row">
          <select
            value={type}
            aria-label="Filter by type"
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All types</option>
            {data?.types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary" disabled={!data || data.unread === 0} onClick={readAll}>
            Mark all read
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {data && data.items.length === 0 && <p className="muted">Nothing here.</p>}
        <ul className="notif-list notif-list-page">
          {data?.items.map((row) => (
            <li key={row.id}>
              <Link to={row.link} className={`notif-row${row.readAt ? "" : " notif-row-unread"}`} onClick={() => open(row)}>
                <span className="notif-row-title">{row.title}</span>
                <span className="notif-row-body">{row.body}</span>
                <span className="notif-row-when">{notificationWhen(row.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="form-actions">
            <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Newer
            </button>
            <span className="muted">
              Page {page} of {pages}
            </span>
            <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Older
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
