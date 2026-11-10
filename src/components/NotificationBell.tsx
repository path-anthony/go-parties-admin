import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { NOTIFICATIONS_CHANGED, getNotifications, markAllNotificationsRead, markNotificationRead } from "../lib/api";
import type { NotificationRow } from "../lib/types";
import { notificationWhen } from "../lib/notifications";

const POLL_MS = 60_000;
const PANEL_ROWS = 15;

// The bell in the top bar: the unread count, and a panel with the latest
// notifications, unread first. It asks again once a minute while the tab is
// in front; a session has a fixed end, so asking cannot keep one alive.
// onOpenLink lets the shell reload the page when the link is for the screen
// already showing.
export function NotificationBell({ onOpenLink }: { onOpenLink: () => void }) {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Only the newest question may set the count: a poll that left before a
  // Mark all read must not bring the old number back.
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const asked = ++latest.current;
    getNotifications({ limit: PANEL_ROWS })
      .then((r) => {
        if (asked !== latest.current) return;
        setRows(r.items);
        setUnread(r.unread);
        setError(null);
      })
      .catch((err) => {
        if (asked === latest.current) setError(err instanceof Error ? err.message : "Couldn't load notifications");
      });
  }, []);

  useEffect(() => {
    refresh();
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function openRow(row: NotificationRow) {
    setOpen(false);
    onOpenLink();
    if (!row.readAt) markNotificationRead(row.id).catch(() => undefined);
  }

  async function readAll() {
    try {
      await markAllNotificationsRead();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    }
  }

  const badge = unread > 99 ? "99+" : String(unread);
  return (
    <div className="notif-bell" ref={ref}>
      <button
        type="button"
        className="icon-btn notif-bell-btn"
        onClick={() => {
          setOpen((o) => !o);
          refresh();
        }}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="notif-panel" role="region" aria-label="Notifications">
          <div className="notif-panel-head">
            <strong>Notifications</strong>
            <button type="button" className="notif-text-btn" disabled={unread === 0} onClick={readAll}>
              Mark all read
            </button>
          </div>
          {error && <p className="form-error notif-panel-note">{error}</p>}
          {rows.length === 0 && !error && <p className="muted notif-panel-note">Nothing yet.</p>}
          <ul className="notif-list">
            {rows.map((row) => (
              <li key={row.id}>
                <Link to={row.link} className={`notif-row${row.readAt ? "" : " notif-row-unread"}`} onClick={() => openRow(row)}>
                  <span className="notif-row-title">{row.title}</span>
                  <span className="notif-row-body">{row.body}</span>
                  <span className="notif-row-when">{notificationWhen(row.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Link to="/notifications" className="notif-panel-foot" onClick={() => setOpen(false)}>
            See all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
