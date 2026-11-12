import { useCallback, useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { getBookings, getBookingsList, getItems, getLeads, getUnits } from "../../lib/api";
import type { Booking, BookingListRow, BookingViewKey, BookingsList, Item, Lead, Unit } from "../../lib/types";
import { BookingModal } from "../BookingModal";
import { NewBookingModal } from "../NewBookingModal";

// Block F3b. Bookings is one list in four views: Needs action (where it
// opens), Upcoming, Past and Cancelled. The views are filters on this one
// list, kept in the address (?view=) so a view can be bookmarked; they are
// buttons, not tabs and not pages. Each row is short: when, who, what for,
// what, how much, and one status in words. Everything else is in the popup.

const EMPTY: Record<BookingViewKey, string> = {
  "needs-action": "Nothing needs action. Every booking is signed, accepted, paid up to date and staffed.",
  upcoming: "There are no upcoming bookings.",
  past: "No events have happened yet.",
  cancelled: "Nothing has been cancelled.",
};

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const shortDay = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const isView = (v: string | null, list: BookingsList | null): v is BookingViewKey => !!v && !!list?.views.some((t) => t.key === v);
const STATUS_CLASS: Record<string, string> = { Confirmed: "bstatus bstatus-ok", Done: "bstatus bstatus-quiet", Cancelled: "bstatus bstatus-quiet" };

export function BookingsScreen() {
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<BookingsList | null>(null);
  // What the popup edits with: the full bookings, the units, the items and
  // the leads, loaded the first time a booking is opened.
  const [full, setFull] = useState<{ bookings: Booking[]; units: Unit[]; items: Item[]; leads: Lead[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  // What was just sent, handed over when a booking is made from a lead or a request.
  const arrived = (useLocation().state as { flash?: string | null } | null)?.flash ?? null;
  const [flash, setFlash] = useState<{ id: string; text: string } | null>(() => (arrived && params.get("booking") ? { id: params.get("booking") as string, text: arrived } : null));

  const load = useCallback(() => getBookingsList().then(setList), []);
  const loadFull = useCallback(async () => {
    const [bookings, units, items, leads] = await Promise.all([getBookings(), getUnits(), getItems(), getLeads()]);
    setFull({ bookings, units, items, leads });
  }, []);

  useEffect(() => {
    let live = true;
    getBookingsList()
      .then((l) => live && setList(l))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load the bookings"));
    return () => {
      live = false;
    };
  }, []);

  // ?view=upcoming picks the view; ?booking=<id> opens the popup.
  const wanted = params.get("view");
  const view: BookingViewKey = isView(wanted, list) ? wanted : "needs-action";
  const openId = params.get("booking");
  const setView = (next: BookingViewKey) => {
    const q = new URLSearchParams(params);
    if (next === "needs-action") q.delete("view");
    else q.set("view", next);
    setParams(q, { replace: true });
  };
  const open = useCallback(
    (id: string | null) => {
      const q = new URLSearchParams(params);
      if (id) q.set("booking", id);
      else q.delete("booking");
      setParams(q, { replace: true });
    },
    [params, setParams],
  );

  useEffect(() => {
    if (!openId || full) return;
    let live = true;
    Promise.all([getBookings(), getUnits(), getItems(), getLeads()])
      .then(([bookings, units, items, leads]) => live && setFull({ bookings, units, items, leads }))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load that booking"));
    return () => {
      live = false;
    };
  }, [openId, full]);

  const needle = search.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  const filtering = needle !== "" || from !== "" || to !== "" || status !== "";
  const matches = (r: BookingListRow) => {
    if (from && r.eventDate < from) return false;
    if (to && r.eventDate > to) return false;
    if (status && r.status !== status) return false;
    if (needle === "") return true;
    if (r.customerName.toLowerCase().includes(needle) || (r.email ?? "").toLowerCase().includes(needle)) return true;
    return digits.length >= 3 && (r.phone ?? "").replace(/\D/g, "").includes(digits);
  };
  // Needs action and Upcoming read soonest first; Past and Cancelled newest first.
  const inView = (list?.rows ?? []).filter((r) => r.views.includes(view));
  const rows = (view === "past" || view === "cancelled" ? [...inView].reverse() : inView).filter(matches);
  const openBooking = openId && full ? full.bookings.find((b) => b.id === openId) : undefined;
  const viewHelp = list?.views.find((v) => v.key === view)?.help ?? "";

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Bookings</h2>
        <p className="muted">Every booking, with one plain status each. The list opens on the bookings that are waiting on something. Open a row to see who, what and where, the money, the paperwork, the history and the next action.</p>
      </div>

      <section className="panel">
        <div className="scheduling-actions">
          <button type="button" className="btn-primary" onClick={() => setNewOpen(true)}>
            New booking
          </button>
          <span className="muted">For a customer booking by phone or in person. Three short steps: who, what and when, then review and send.</span>
        </div>
        <div className="filter-row" role="group" aria-label="Which bookings to show">
          {(list?.views ?? []).map((v) => (
            <button key={v.key} type="button" aria-pressed={view === v.key} className={view === v.key ? "btn-primary" : "btn-secondary"} onClick={() => setView(v.key)} data-view={v.key}>
              {v.label} ({v.count})
            </button>
          ))}
        </div>
        <p className="muted field-help">{viewHelp}</p>
        <div className="filter-row bookings-filters">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by customer name, email or phone" aria-label="Search bookings" />
          <label>
            Event from
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Event date from" />
          </label>
          <label>
            to
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Event date to" />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">Any status</option>
              {(list?.statuses ?? []).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {filtering && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setSearch("");
                setFrom("");
                setTo("");
                setStatus("");
              }}
            >
              Clear
            </button>
          )}
        </div>
        <p className="muted field-help">Search and the filters narrow the view you are in. To search every booking, pick Upcoming or Past first.</p>

        {error && <p className="form-error">{error}</p>}
        {!list && !error && <p className="muted">Loading…</p>}
        {list && rows.length === 0 && <p className="muted">{filtering ? "Nothing in this view matches." : EMPTY[view]}</p>}
        {list && rows.length > 0 && (
          <ul className="inbox-list" aria-label="Bookings">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" className="inbox-row booking-row" onClick={() => open(r.id)} data-booking={r.id} aria-haspopup="dialog">
                  <span className="booking-row-when">
                    <strong>{shortDay(r.eventDate)}</strong>
                    <span className="muted">{r.eventTime ?? "No time yet"}</span>
                  </span>
                  <span className="inbox-who">
                    <strong>{r.customerName}</strong>
                    {r.rush && <span className="reason-pill">RUSH</span>}
                  </span>
                  <span className="inbox-wants">{r.occasion ?? "Occasion not given"}</span>
                  <span className="inbox-wants">{r.items}</span>
                  <span className="booking-row-total">{r.total === null ? "No price yet" : usd(r.total)}</span>
                  <span className="booking-row-status">
                    <span className={STATUS_CLASS[r.status] ?? "bstatus"} data-status={r.status}>
                      {r.status}
                    </span>
                    {r.needs.length > 0 && <span className="inbox-next inbox-next-now">{r.needs.map((n) => n.label).join(" · ")}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list && rows.length > 0 && <p className="muted field-help">Columns: date and time, customer, occasion, items, total, and the status. Under the status, a row in Needs action says what it is waiting on.</p>}
      </section>

      {newOpen && (
        <NewBookingModal
          onClose={() => setNewOpen(false)}
          onCreated={async (bookingId, said) => {
            await Promise.all([load(), loadFull()]);
            setNewOpen(false);
            setFlash(said ? { id: bookingId, text: said } : null);
            open(bookingId);
          }}
        />
      )}

      {openId && !openBooking && !error && (
        <div className="modal-backdrop">
          <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Booking">
            <p className="muted">{full ? "That booking was not found." : "Loading…"}</p>
            {full && (
              <button type="button" className="btn-secondary" onClick={() => open(null)}>
                Close
              </button>
            )}
          </div>
        </div>
      )}
      {openBooking && full && (
        <BookingModal
          booking={openBooking}
          leads={full.leads}
          units={full.units}
          items={full.items}
          bookings={full.bookings}
          flash={flash && flash.id === openBooking.id ? flash.text : null}
          onUpdated={(updated) => {
            setFull((prev) => (prev ? { ...prev, bookings: prev.bookings.map((b) => (b.id === updated.id ? updated : b)) } : prev));
            void load();
            void getUnits().then((units) => setFull((prev) => (prev ? { ...prev, units } : prev)));
          }}
          onClose={() => {
            open(null);
            setFlash(null);
          }}
        />
      )}
    </div>
  );
}
