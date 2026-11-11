import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate as useRouterNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { addLeadActivity, getBookings, getDesignRequest, getInbox, getLeadActivity, getLeadDetail, getUnits, logLeadContact, markLeadLost, reopenLead, sendLeadStoreLink, setLeadFollowUp, updateDesignRequest, updateLead } from "../lib/api";
import type { DesignRequest, InboxRow, LeadActivity, LeadDetail, LeadPatch, LeadPrefill } from "../lib/types";
import { AutomationTimeline } from "./AutomationTimeline";
import { EditableCell } from "./EditableCell";
import { CancellationRequests } from "./MoneyControls";
import { NewBookingModal } from "./NewBookingModal";
import { RecordMessages } from "./RecordMessages";

// Block F3a. One popup for every lead, storefront request and cancellation
// request, always in the same four parts: Who, What they want, History, Next
// action. Staff should never have to hunt for the next step.

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const day = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const prettyPhone = (ten: string) => `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;

export type PopupTarget = { kind: "lead" | "request"; id: string };

function Part({ n, title, help, children }: { n: number; title: string; help: string; children: ReactNode }) {
  return (
    <section className="lead-part" aria-label={title}>
      <h3>
        {n}. {title}
      </h3>
      <p className="muted field-help">{help}</p>
      {children}
    </section>
  );
}

// Phone and email as things to tap: call, text, email.
function ContactLinks({ phone, email }: { phone: string | null; email: string | null }) {
  if (!phone && !email) return <p className="muted">No phone number or email address yet. Add one to the contact line below.</p>;
  return (
    <div className="lead-contact-links">
      {phone && (
        <>
          <a className="btn-secondary" href={`tel:+1${phone}`}>
            Call {prettyPhone(phone)}
          </a>
          <a className="btn-secondary" href={`sms:+1${phone}`}>
            Text
          </a>
        </>
      )}
      {email && (
        <a className="btn-secondary" href={`mailto:${email}`}>
          Email {email}
        </a>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lead-fact">
      <span className="detail-field-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { call: "Call", text: "Text", email: "Email", status: "Change" };

export function LeadPopup({ target, row, onClose, onChanged }: { target: PopupTarget; row?: InboxRow | null; onClose: () => void; onChanged: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={target.kind === "lead" ? "Lead" : "Storefront request"} onClick={(e) => e.stopPropagation()}>
        {target.kind === "lead" ? <LeadBody key={target.id} id={target.id} row={row ?? null} onClose={onClose} onChanged={onChanged} /> : <RequestBody key={target.id} id={target.id} onClose={onClose} onChanged={onChanged} />}
      </div>
    </div>
  );
}

function Head({ title, sub, onClose }: { title: string; sub: string; onClose: () => void }) {
  return (
    <div className="modal-head">
      <div>
        <h2>{title}</h2>
        <span className="muted">{sub}</span>
      </div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
}

// ---- a lead ---------------------------------------------------------------------------

type Doing = null | "contact" | "follow-up" | "lost" | "store-link";

function LeadBody({ id, row: givenRow, onClose, onChanged }: { id: string; row: InboxRow | null; onClose: () => void; onChanged: () => void }) {
  const go = useRouterNavigate();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [row, setRow] = useState<InboxRow | null>(givenRow);
  const [meta, setMeta] = useState<{ lostReasons: string[]; columns: string[] } | null>(null);
  const [activity, setActivity] = useState<LeadActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [doing, setDoing] = useState<Doing>(null);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  // the small forms
  const [kind, setKind] = useState<"call" | "text" | "email">("call");
  const [note, setNote] = useState("");
  const [followDate, setFollowDate] = useState("");
  const [reason, setReason] = useState("");
  const [entry, setEntry] = useState("");

  const load = useCallback(async () => {
    const [detail, inbox, entries] = await Promise.all([getLeadDetail(id), getInbox(), getLeadActivity(id)]);
    setLead(detail);
    setRow(inbox.rows.find((r) => r.kind === "lead" && r.id === id) ?? null);
    setMeta({ lostReasons: inbox.lostReasons, columns: inbox.columns });
    setActivity(entries);
  }, [id]);

  useEffect(() => {
    let live = true;
    Promise.all([getLeadDetail(id), getInbox(), getLeadActivity(id)])
      .then(([detail, inbox, entries]) => {
        if (!live) return;
        setLead(detail);
        setRow(inbox.rows.find((r) => r.kind === "lead" && r.id === id) ?? null);
        setMeta({ lostReasons: inbox.lostReasons, columns: inbox.columns });
        setActivity(entries);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load this lead"));
    return () => {
      live = false;
    };
  }, [id]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const said = await fn();
      setNotice(said);
      setDoing(null);
      setNote("");
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save");
    } finally {
      setBusy(false);
    }
  }
  const save = (patch: LeadPatch) => updateLead(id, patch).then(() => load().then(onChanged));

  if (!lead) {
    return (
      <>
        <Head title="Lead" sub="" onClose={onClose} />
        {error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }

  const booking = lead.bookings.find((b) => b.status !== "Cancelled" && b.status !== "Released") ?? lead.bookings[0] ?? null;
  const bucket = row?.bucket ?? "follow-up";
  const code = row?.nextAction.code ?? "";
  const hasCancellation = code === "cancellation";
  const open = bucket === "new" || bucket === "follow-up";
  const prefill: LeadPrefill = { id: lead.id, name: lead.name ?? "", phone: lead.phone ?? "", email: lead.email ?? "", date: lead.dateOfInterest ?? "", itemIds: (lead.itemsReturned?.items ?? []).map((i) => i.id) };

  // The one main button, from where the lead stands.
  const main: { label: string; run: () => void } | null = hasCancellation
    ? null
    : bucket === "booked" && booking
      ? { label: "Open the booking", run: () => go(`/bookings?booking=${booking.id}`) }
      : bucket === "lost"
        ? lead.bookings.length === 0
          ? { label: "Reopen this lead", run: () => void act(async () => `Reopened. Moved to ${(await reopenLead(id)).status}.`) }
          : null
        : code === "set-next-step"
          ? { label: "Set a follow up date", run: () => setDoing("follow-up") }
          : { label: bucket === "new" ? "Log your first contact" : "Log a contact", run: () => setDoing("contact") };

  return (
    <>
      <Head title={lead.name ?? "No name yet"} sub={`${lead.source} lead · ${row ? row.nextAction.label : lead.stage}`} onClose={onClose} />
      {error && <p className="form-error">{error}</p>}
      {notice && (
        <p className="bulk-result" role="status">
          {notice}
        </p>
      )}
      <div className="lead-popup-grid">
        <Part n={1} title="Who" help="Who they are and how to reach them. Tap to call, text or email, then log it under Next action.">
          <ContactLinks phone={lead.phone} email={lead.email} />
          <Fact label="Name">
            <EditableCell value={lead.name ?? ""} ariaLabel="Name" onSave={(v) => save({ customerName: v })} />
          </Fact>
          <Fact label="Phone and email">
            <EditableCell value={lead.contact ?? ""} ariaLabel="Phone and email" onSave={(v) => save({ contact: v })} />
          </Fact>
          <Fact label="Came from">{lead.source}</Fact>
          <Fact label="Arrived">{when(lead.createdAt)} ET</Fact>
          {lead.possibleMatches.length > 0 && (
            <div className="stage-warning" role="note">
              <strong>Possible match.</strong> {lead.possibleMatches.length === 1 ? "Another lead looks" : "Other leads look"} like the same person. Nothing was merged. Check before you contact them twice:
              <ul className="addon-list">
                {lead.possibleMatches.map((m) => (
                  <li key={m.id}>
                    <a href={`/leads?lead=${m.id}`}>
                      {m.name}
                    </a>{" "}
                    · {m.source} · {m.stage} · added {day(m.createdAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Part>

        <Part n={2} title="What they want" help={booking ? "From the booking made for this lead." : "What they asked for. Fill in what you learn when you talk to them."}>
          {booking ? (
            <>
              <Fact label={booking.packageName ? "Package" : "Items"}>{booking.packageName ?? (booking.items.length > 0 ? booking.items.join(", ") : "None listed")}</Fact>
              {booking.addons.length > 0 && <Fact label="Options">{booking.addons.map((a) => `${a.groupName}: ${a.addonName}`).join(", ")}</Fact>}
              <Fact label="Event date">
                {day(booking.eventDate)}
                {booking.eventTime ? `, ${booking.eventTime}` : ""}
              </Fact>
              <Fact label="Guest count">{booking.guestCount ?? "Not given"}</Fact>
              <Fact label="Occasion">{booking.occasion ?? lead.occasion ?? "Not given"}</Fact>
              <Fact label="Event address">
                {booking.address ?? "Not given yet"}
                {booking.mapsUrl && (
                  <>
                    {" · "}
                    <a href={booking.mapsUrl} target="_blank" rel="noreferrer">
                      Open the map
                    </a>
                  </>
                )}
              </Fact>
              <Fact label="Setup notes">{booking.setupNotes ?? "None"}</Fact>
              <Fact label="Total">{booking.total === null ? "No price yet" : usd(booking.total)}</Fact>
            </>
          ) : (
            <>
              {lead.itemsReturned && lead.itemsReturned.items.length > 0 && (
                <Fact label="Items they looked at (Ask GO)">
                  {lead.itemsReturned.items.map((i) => i.name).join(", ")} · {usd(lead.itemsReturned.total)}
                </Fact>
              )}
              {lead.theme && <Fact label="They asked">{lead.theme}</Fact>}
              <Fact label="Occasion or what they want">
                <EditableCell value={lead.occasion ?? ""} ariaLabel="Occasion" placeholder="Add" onSave={(v) => save({ occasion: v })} />
              </Fact>
              <Fact label="Event date">
                <EditableCell type="date" value={lead.dateOfInterest ?? ""} ariaLabel="Event date" onSave={(v) => save({ dateOfInterest: v === "" ? null : v })} />
              </Fact>
              <Fact label="Guest count, address and setup notes">Not collected until a booking is made. Put what you learn in the message below.</Fact>
            </>
          )}
          <Fact label="Their message, and your notes">
            <EditableCell value={lead.notes ?? ""} multiline ariaLabel="Message and notes" placeholder="Add" onSave={(v) => save({ notes: v })} />
          </Fact>
        </Part>

        <Part n={3} title="History" help="Every contact, every message sent and every change, newest first. Add a note any time.">
          <form
            className="activity-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (entry.trim() === "") return;
              void act(async () => {
                await addLeadActivity(id, entry.trim());
                setEntry("");
                return "Note added.";
              });
            }}
          >
            <textarea rows={2} value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="Add a note" aria-label="New note" maxLength={2000} disabled={busy} />
            <div className="form-actions">
              <button type="submit" className="btn-secondary" disabled={busy || entry.trim() === ""}>
                Add note
              </button>
            </div>
          </form>
          {activity && activity.length === 0 && <p className="muted">Nothing has happened on this lead yet.</p>}
          {activity && activity.length > 0 && (
            <ul className="activity-list">
              {activity.map((a) => (
                <li key={a.id} className="activity-entry">
                  <span className="activity-time">{when(a.createdAt)}</span>
                  {a.kind && KIND_LABEL[a.kind] ? <strong>{KIND_LABEL[a.kind]}: </strong> : null}
                  {a.text}
                  {a.userName && <span className="muted"> · {a.userName}</span>}
                </li>
              ))}
            </ul>
          )}
          <RecordMessages leadId={lead.id} />
          <AutomationTimeline kind="lead" id={lead.id} />
        </Part>

        <Part n={4} title="Next action" help={row ? `${row.nextAction.label}. The main button is the next thing to do; the others are there when you need them.` : "What to do next."}>
          {hasCancellation && <CancellationRequests leadId={lead.id} onDecided={() => void load().then(onChanged)} />}
          {lead.followUpOn && open && (
            <p className="muted">
              Follow up set for {day(lead.followUpOn)}
              {lead.followUpNote ? `: ${lead.followUpNote}` : "."}
            </p>
          )}
          {bucket === "lost" && lead.lostReason && (
            <p className="muted">
              Lost: {lead.lostReason}
              {lead.lostNote ? `. ${lead.lostNote}` : ""}
              {lead.lostAt ? ` (${when(lead.lostAt)} ET)` : ""}
            </p>
          )}
          {main && doing === null && (
            <button type="button" className="btn-primary lead-main-action" disabled={busy} onClick={main.run}>
              {main.label}
            </button>
          )}

          {doing === "contact" && (
            <form
              className="add-item-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const r = await logLeadContact(id, kind, note.trim() || null);
                  return r.movedTo ? `Logged. This was the first contact, so the lead moved to ${r.movedTo}.` : "Logged.";
                });
              }}
            >
              <div className="filter-row" role="group" aria-label="How you reached them">
                {(["call", "text", "email"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? "btn-primary" : "btn-secondary"} onClick={() => setKind(k)}>
                    {k === "call" ? "Call" : k === "text" ? "Text" : "Email"}
                  </button>
                ))}
              </div>
              <label>
                What was said
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Left a voicemail, wants a quote for 80 guests" disabled={busy} />
              </label>
              <span className="muted field-help">This writes the contact in History. It does not send anything. The first contact moves a new lead to Contacted.</span>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {busy ? "Saving…" : "Save contact"}
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {doing === "follow-up" && (
            <form
              className="add-item-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await setLeadFollowUp(id, followDate, note.trim() || null);
                  return `Follow up set for ${day(followDate)}. It will show on Today that morning.`;
                });
              }}
            >
              <label>
                Follow up on
                <input type="date" min={today()} value={followDate} onChange={(e) => setFollowDate(e.target.value)} required disabled={busy} />
              </label>
              <label>
                Note
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Waiting on the venue, call after the 15th" disabled={busy} />
              </label>
              <span className="muted field-help">Use this when they are not ready to book. The lead shows under Nurture on Today when the day comes.</span>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy || followDate === ""}>
                  Save follow up
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {doing === "lost" && (
            <form
              className="add-item-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await markLeadLost(id, reason, note.trim() || null);
                  return "Marked Lost. It stays in the Lost list and can be reopened.";
                });
              }}
            >
              <label>
                Why was it lost?
                <select value={reason} onChange={(e) => setReason(e.target.value)} required disabled={busy}>
                  <option value="">Pick a reason</option>
                  {(meta?.lostReasons ?? []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={busy} />
              </label>
              <span className="muted field-help">For your team only. Nothing is sent to the customer, and follow up messages stop.</span>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy || reason === ""}>
                  Mark Lost
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {doing === "store-link" && (
            <div className="add-item-form">
              <p className="stage-warning" role="note">
                This sends {lead.name ?? "the customer"} a link to the store by {[lead.phone ? "text" : null, lead.email ? "email" : null].filter(Boolean).join(" and ") || "nothing, because there is no phone or email"}, so they can pick items and hold their own date. The wording is the "Store link" message in Messages, Templates.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || (!lead.phone && !lead.email)}
                  onClick={() =>
                    void act(async () => {
                      const r = await sendLeadStoreLink(id);
                      return `Store link sent by ${r.sent.join(" and ")}.${r.movedTo ? ` The lead moved to ${r.movedTo}.` : ""}`;
                    })
                  }
                >
                  {busy ? "Sending…" : "Send it"}
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {doing === null && open && (
            <div className="lead-other-actions">
              <span className="detail-field-label">Contact</span>
              <div className="form-actions">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing("contact")}>
                  Log a call, text or email
                </button>
              </div>
              <span className="detail-field-label">How they buy</span>
              <div className="form-actions">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing("store-link")}>
                  Send store link
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setBuilding(true)}>
                  Build a booking for them
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing("follow-up")}>
                  Not ready
                </button>
              </div>
              <span className="muted field-help">
                Send store link: they book themselves{lead.storeLinkSentAt ? ` (last sent ${when(lead.storeLinkSentAt)} ET)` : ""}. Build a booking: you make it for them, filled in from this lead. Not ready: set the day to come back to them.
              </span>
              <span className="detail-field-label">Close</span>
              <div className="form-actions">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDoing("lost")}>
                  Lost
                </button>
              </div>
            </div>
          )}
          {doing === null && bucket === "booked" && !booking && (
            <div className="form-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setBuilding(true)}>
                Build a booking for them
              </button>
            </div>
          )}

          <details className="lead-more">
            <summary>Column and tags</summary>
            <label>
              Lead column
              <select value={lead.stage} disabled={busy} onChange={(e) => void act(async () => (await updateLead(id, { status: e.target.value }), `Moved to ${e.target.value}.`))}>
                {(meta?.columns ?? [lead.stage]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted field-help">The column moves on its own: Contacted on the first contact, Booked when a booking is made, Lost when you close it. Change it here only to correct it.</span>
            {lead.tags.length > 0 && <p className="muted">Tags: {lead.tags.join(", ")}</p>}
          </details>
        </Part>
      </div>

      {building && (
        <NewBookingModal
          lead={prefill}
          onClose={() => setBuilding(false)}
          onReview={() => setBuilding(false)}
          onCreated={async () => {
            await Promise.all([getBookings(), getUnits()]);
            setBuilding(false);
            setNotice("Booking made and linked to this lead. The lead moved to Booked.");
            await load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

// ---- a storefront request --------------------------------------------------------------

function RequestBody({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [r, setR] = useState<DesignRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const [tell, setTell] = useState(false);
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    const got = await getDesignRequest(id);
    setR(got);
    setNotes(got.notes ?? "");
  }, [id]);
  useEffect(() => {
    let live = true;
    getDesignRequest(id)
      .then((got) => {
        if (!live) return;
        setR(got);
        setNotes(got.notes ?? "");
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load this request"));
    return () => {
      live = false;
    };
  }, [id]);

  async function change(patch: Parameters<typeof updateDesignRequest>[1], said: (saved: Awaited<ReturnType<typeof updateDesignRequest>>) => string) {
    setBusy(true);
    setError(null);
    try {
      const saved = await updateDesignRequest(id, patch);
      setNotice(said(saved));
      setDismissing(false);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (!r) {
    return (
      <>
        <Head title="Storefront request" sub="" onClose={onClose} />
        {error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>}
      </>
    );
  }
  const phone = (r.phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return (
    <>
      <Head title={r.customerName} sub={`Storefront request · ${r.status === "Open" ? "Review it, then convert or dismiss" : r.status}`} onClose={onClose} />
      {error && <p className="form-error">{error}</p>}
      {notice && (
        <p className="bulk-result" role="status">
          {notice}
        </p>
      )}
      <div className="lead-popup-grid">
        <Part n={1} title="Who" help="The customer who sent this order from the store. They were told a person would be in touch.">
          <ContactLinks phone={phone.length === 10 ? phone : null} email={r.email} />
          <Fact label="Name">{r.customerName}</Fact>
          <Fact label="Came from">Storefront{r.customerId ? " (has an account)" : ""}</Fact>
          <Fact label="Arrived">{when(r.createdAt)} ET</Fact>
        </Part>

        <Part n={2} title="What they want" help="Everything the customer chose and typed at checkout. Nothing is held yet.">
          <Fact label={r.cart.package ? "Package" : "Items"}>
            {r.cart.package ? `${r.cart.package.name}, ${usd(r.cart.package.price)}` : ""}
            <ul className="request-cart">
              {r.cart.items.map((i) => (
                <li key={i.itemId}>
                  {i.name}
                  {i.quantity > 1 ? ` × ${i.quantity}` : ""}
                  {r.cart.addons
                    .filter((a) => a.itemId === i.itemId)
                    .map((a) => ` · ${a.groupName}: ${a.addonName}`)
                    .join("")}
                </li>
              ))}
            </ul>
          </Fact>
          <Fact label="Event date">
            {day(r.eventDate)}
            {r.eventTime ? `, ${r.eventTime}` : ""}
          </Fact>
          <Fact label="Guest count">{r.guestCount ?? "Not given"}</Fact>
          <Fact label="Occasion">{r.occasion ?? "Not given"}</Fact>
          <Fact label="Event address">
            {r.address ?? "Not given"}
            {r.eventAddressSameAsHome ? " (same as their home address)" : ""}
            {r.mapsUrl && (
              <>
                {" · "}
                <a href={r.mapsUrl} target="_blank" rel="noreferrer">
                  Open the map
                </a>
              </>
            )}
          </Fact>
          <Fact label="Setup notes">{r.setupNotes ?? "None"}</Fact>
          <Fact label="Total">{r.total === null ? "No price" : usd(r.total)}</Fact>
          <Fact label="Why it needs you">{r.reviewReason ?? "The total is at or over the review amount"}</Fact>
        </Part>

        <Part n={3} title="History" help="Your team's notes on this request. The customer never sees them.">
          <Fact label="Received">{when(r.createdAt)} ET</Fact>
          {r.status === "Dismissed" && (
            <Fact label="Dismissed">
              {r.dismissedByName ? `By ${r.dismissedByName}` : ""}
              {r.dismissedAt ? `, ${when(r.dismissedAt)} ET` : ""}: {r.dismissReason ?? "no reason"}. {r.customerToldAt ? "The customer was told by email." : "The customer was not told."}
            </Fact>
          )}
          {r.status === "Converted" && <Fact label="Converted">It is a booking now. Find it in Bookings.</Fact>}
          <label className="detail-field request-notes">
            <span className="detail-field-label">Staff notes</span>
            <textarea rows={3} maxLength={2000} value={notes} disabled={busy} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed, what to quote, who is handling it" />
          </label>
          {notes.trim() !== (r.notes ?? "").trim() && (
            <div className="form-actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void change({ notes: notes.trim() === "" ? null : notes.trim() }, () => "Notes saved.")}>
                Save notes
              </button>
            </div>
          )}
        </Part>

        <Part n={4} title="Next action" help="Convert makes the booking and holds the date; you can change anything first, the price included. Dismiss closes the request with a reason.">
          {r.status === "Open" && !dismissing && (
            <>
              <button type="button" className="btn-primary lead-main-action" disabled={busy} onClick={() => setConverting(true)}>
                Convert to a booking
              </button>
              <div className="form-actions">
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDismissing(true)}>
                  Dismiss
                </button>
              </div>
            </>
          )}
          {r.status === "Open" && dismissing && (
            <form
              className="add-item-form"
              onSubmit={(e) => {
                e.preventDefault();
                void change({ status: "Dismissed", reason: reason.trim(), tellCustomer: tell }, (saved) => (saved.customerTold ? (saved.customerTold.sent ? "Dismissed. The customer was told by email." : `Dismissed. The email did not go: ${saved.customerTold.why}`) : "Dismissed. The customer was not told."));
              }}
            >
              <label>
                Why is this request being dismissed?
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required disabled={busy} placeholder="Out of our area, date not available, duplicate" />
                <span className="muted field-help">For your team only. The customer never sees this.</span>
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={tell} disabled={busy || !r.email} onChange={(e) => setTell(e.target.checked)} />
                Tell the customer by email
              </label>
              <span className="muted field-help">{r.email ? `Sends the "Request closed" email to ${r.email}. Edit its wording in Messages, Templates.` : "There is no email address on this request, so nothing can be sent."}</span>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy || reason.trim() === ""}>
                  Dismiss request
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setDismissing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {r.status === "Dismissed" && (
            <button type="button" className="btn-primary lead-main-action" disabled={busy} onClick={() => void change({ status: "Open" }, () => "Reopened. It is waiting again.")}>
              Reopen this request
            </button>
          )}
          {r.status === "Converted" && <p className="muted">Nothing to do here. The booking carries on in Bookings.</p>}
        </Part>
      </div>

      {converting && (
        <NewBookingModal
          request={r}
          onClose={() => setConverting(false)}
          onReview={() => setConverting(false)}
          onCreated={async () => {
            await Promise.all([getBookings(), getUnits()]);
            setConverting(false);
            setNotice(`Turned ${r.customerName}'s request into a booking. It is in Bookings, and the customer has been sent what they owe next.`);
            await load();
            onChanged();
          }}
        />
      )}
    </>
  );
}
