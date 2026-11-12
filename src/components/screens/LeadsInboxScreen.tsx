import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getInbox, getLeadStatuses } from "../../lib/api";
import type { Inbox, InboxRow, InboxTabKey } from "../../lib/types";
import { AddLeadForm } from "../AddLeadForm";
import { LeadPopup, type PopupTarget } from "../LeadPopup";

// Block F3a. Leads is one inbox: everyone who might buy, wherever they came
// from, with the next thing to do on every row. The views across the top are
// filters on this one list (kept in the address so a view can be bookmarked),
// not separate pages.

const TAB_HELP: Record<InboxTabKey, string> = {
  all: "Everyone, with the ones that need you first.",
  new: "Nobody has contacted these people yet. Contact them, then log it.",
  requests: "Orders sent from the store that need a person before a date is held. Convert each one to a booking or dismiss it.",
  cancellations: "Customers who asked to cancel. Their booking is still held until you approve or decline.",
  "follow-up": "People you have contacted who have not booked. Each one should have a next step with a date.",
  booked: "Leads with a booking that is going ahead.",
  lost: "Leads you closed, bookings that were cancelled, and requests you dismissed.",
};
const EMPTY: Record<InboxTabKey, string> = {
  all: "There are no leads yet. They appear here from the website form, the store, Ask GO, and when you add one.",
  new: "No new leads are waiting. Everyone has been contacted.",
  requests: "No storefront requests are waiting.",
  cancellations: "Nobody has asked to cancel.",
  "follow-up": "Nobody is waiting on a follow up.",
  booked: "No leads have a booking yet.",
  lost: "Nothing has been lost or dismissed.",
};

const shortDay = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const age = (days: number) => (days === 0 ? "New today" : days === 1 ? "1 day old" : `${days} days old`);
const prettyPhone = (ten: string) => `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
const isTab = (v: string | null, inbox: Inbox | null): v is InboxTabKey => !!v && !!inbox?.tabs.some((t) => t.key === v);

export function LeadsInboxScreen() {
  const [params, setParams] = useSearchParams();
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(() => getInbox().then(setInbox), []);
  useEffect(() => {
    let live = true;
    Promise.all([getInbox(), getLeadStatuses()])
      .then(([i, s]) => {
        if (!live) return;
        setInbox(i);
        setStatuses(s.map((x) => x.name));
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load the leads"));
    return () => {
      live = false;
    };
  }, []);

  // ?view=requests picks the view; ?lead=<id> or ?request=<id> opens the popup.
  const wanted = params.get("view");
  const view: InboxTabKey = isTab(wanted, inbox) ? wanted : "all";
  const target: PopupTarget | null = params.get("lead") ? { kind: "lead", id: params.get("lead") as string } : params.get("request") ? { kind: "request", id: params.get("request") as string } : null;
  const setView = (next: InboxTabKey) => {
    const q = new URLSearchParams(params);
    if (next === "all") q.delete("view");
    else q.set("view", next);
    setParams(q, { replace: true });
  };
  const open = (row: InboxRow | null) => {
    const q = new URLSearchParams(params);
    q.delete("lead");
    q.delete("request");
    // A lead with a storefront request waiting opens the request.
    if (row) q.set(row.requestId ? "request" : row.kind, row.requestId ?? row.id);
    setParams(q, { replace: true });
  };

  const needle = search.trim().toLowerCase();
  const rows = (inbox?.rows ?? []).filter((r) => r.tabs.includes(view) && (needle === "" || `${r.name} ${r.contactText ?? ""} ${r.wants} ${r.source}`.toLowerCase().includes(needle)));

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Leads</h2>
        <p className="muted">Everyone who might buy, in one list, wherever they came from: the website form, the store, Ask GO, "Talk to us", the phone. Each row says what to do next. Open one to see who they are, what they want, what has happened, and the next action.</p>
      </div>

      <section className="panel">
        <div className="filter-row" role="group" aria-label="Which leads to show">
          {(inbox?.tabs ?? []).map((t) => (
            <button key={t.key} type="button" aria-pressed={view === t.key} className={view === t.key ? "btn-primary" : "btn-secondary"} onClick={() => setView(t.key)} data-view={t.key}>
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        <p className="muted field-help">{TAB_HELP[view]}</p>
        <div className="filter-row">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, phone, email or what they want" aria-label="Search leads" />
          <button type="button" className="btn-secondary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            Add a lead
          </button>
        </div>
        {adding && (
          <AddLeadForm
            statuses={statuses}
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              void load();
            }}
          />
        )}
        {error && <p className="form-error">{error}</p>}
        {!inbox && !error && <p className="muted">Loading…</p>}
        {inbox && rows.length === 0 && <p className="muted">{needle ? "Nothing matches that search in this view." : EMPTY[view]}</p>}
        {inbox && rows.length > 0 && (
          <ul className="inbox-list" aria-label="Leads">
            {rows.map((r) => (
              <li key={r.key}>
                <button type="button" className="inbox-row" onClick={() => open(r)} data-row={r.key}>
                  <span className="inbox-who">
                    <strong>{r.name}</strong>
                    <span className="inbox-source">{r.source}</span>
                    {r.tabs.includes("requests") && <span className="reason-pill">Storefront request</span>}
                    {r.tabs.includes("cancellations") && <span className="reason-pill">Cancellation request</span>}
                  </span>
                  <span className="inbox-contact">{[r.phone ? prettyPhone(r.phone) : null, r.email].filter(Boolean).join(" · ") || r.contactText || "No contact details"}</span>
                  <span className="inbox-wants">{r.wants}</span>
                  <span className="inbox-date">{r.eventDate ? `Event ${shortDay(r.eventDate)}` : "No date yet"}</span>
                  <span className="inbox-age">{age(r.ageDays)}</span>
                  <span className={r.nextAction.urgent ? "inbox-next inbox-next-now" : "inbox-next"}>{r.nextAction.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {inbox && rows.length > 0 && <p className="muted field-help">Columns: who and where they came from, contact, what they want, event date, how long ago the lead arrived, and the next action.</p>}
      </section>

      {target && <LeadPopup target={target} row={inbox?.rows.find((r) => r.kind === target.kind && r.id === target.id) ?? null} onClose={() => open(null)} onChanged={() => void load()} />}
    </div>
  );
}
