import { useCallback, useEffect, useState } from "react";
import { useNavigate as useRouterNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { addBookingUnit, getBookingSummary, getBookings, getPolicy, removeBookingGig, removeBookingUnit, setBookingAddons, updateBooking } from "../lib/api";
import { BALANCE_PREFERENCES, type BalancePreference, isInactiveStage } from "../lib/bookingStatus";
import { deltaLabel, describeAddon } from "../lib/addons";
import { leadTitle } from "../lib/leads";
import {
  BOOKING_STAGES,
  type AddonGroup,
  type Booking,
  type BookingAddon,
  type BookingGig,
  type BookingPatch,
  type BookingStatus,
  type BookingSummary,
  type Item,
  type Lead,
  type Unit,
} from "../lib/types";
import { EditableCell } from "./EditableCell";
import { AutomationTimeline } from "./AutomationTimeline";
import { ContractDetails } from "./ContractDetails";
import { RecordMessages } from "./RecordMessages";
import { SendMessageControls } from "./SendMessageControls";
import { BookingStatusTag } from "./BookingStatusTag";
import { RushTag } from "./RushTag";
import { PaymentsSection } from "./PaymentsSection";
import { CancellationRequests, PayLinkControl, RefundLog } from "./MoneyControls";
import { ContactLinks, Fact, Part } from "./LeadPopup";
import { DeliverySection } from "./DeliverySection";
import { bookingMapsUrl } from "../lib/maps";
import { WeddingDetailsPanel } from "./WeddingDetailsPanel";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function leadLabel(lead: Lead): string {
  return leadTitle(lead) ?? (lead.theme ? lead.theme.slice(0, 40) : "Lead");
}

// How many units of an item are open on a date, from what this screen
// already has loaded. It's only for the labels in the "add an item" list;
// the server decides for real, under a lock, when a unit is added.
function freeCount(item: Item, date: string, units: Unit[], bookings: Booking[]): number {
  const held = new Set(bookings.filter((b) => b.eventDate.slice(0, 10) === date).flatMap((b) => b.unitIds));
  return units.filter((u) => u.itemId === item.id && u.status === "Available" && !held.has(u.id)).length;
}

// Block F3b. Everything about one booking, in a wide popup in the same style
// as the lead popup, always in this order: Who, What and where, Money,
// Paperwork, History, Next action. Every booking function is still here; it
// only moved under the part it belongs to.
// Text fields save when they're left; selects and checkboxes save on
// change. A date change is a reschedule: the server re-claims a free unit
// of every item on the new date under the same lock a customer's booking
// uses, or refuses and leaves the booking alone. Adding an item claims a
// unit the same way.
export function BookingModal({
  booking,
  leads,
  units,
  items,
  bookings,
  onUpdated,
  onClose,
  flash,
}: {
  booking: Booking;
  leads: Lead[];
  units: Unit[];
  items: Item[];
  bookings: Booking[];
  onUpdated: (booking: Booking) => void;
  onClose: () => void;
  // A line to show at the top, such as what was just sent to the customer.
  flash?: string | null;
}) {
  const go = useRouterNavigate();
  const [busy, setBusy] = useState(false);
  // The status in words, the money, the paperwork and the history, worked
  // out by the server (GET /api/bookings/:id/summary) and read again after
  // every change.
  const [summary, setSummary] = useState<BookingSummary | null>(null);
  const stamp = `${booking.id}:${booking.updatedAt}:${booking.status}:${booking.retainerPaid}:${booking.balancePaid}:${booking.unitIds.length}:${booking.gigs.length}`;
  useEffect(() => {
    let live = true;
    getBookingSummary(booking.id)
      .then((got) => live && setSummary(got))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [booking.id, stamp]);
  const refresh = useCallback(() => {
    void getBookingSummary(booking.id)
      .then(setSummary)
      .catch(() => undefined);
    void getBookings()
      .then((all) => {
        const fresh = all.find((b) => b.id === booking.id);
        if (fresh) onUpdated(fresh);
      })
      .catch(() => undefined);
  }, [booking.id, onUpdated]);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  // Refusals from the click and change controls (adding a unit to a full
  // date, an add-on the item doesn't offer) are shown in full here.
  const [notice, setNotice] = useState<string | null>(null);
  const [addItemId, setAddItemId] = useState("");

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, select")) {
        target.blur();
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // For the save-on-blur fields. A refusal (a date with nothing free, say)
  // is shown in full by the field itself, right under it, so it isn't
  // repeated in the notice; a success clears any older notice.
  async function save(patch: BookingPatch) {
    onUpdated(await updateBooking(booking.id, patch));
    setNotice(null);
  }

  // For the controls that act on click or change.
  async function run(action: () => Promise<Booking>) {
    setBusy(true);
    try {
      onUpdated(await action());
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const who = booking.customerName;
  const date = booking.eventDate.slice(0, 10);
  const cancelled = isInactiveStage(booking.status);
  const held = booking.unitIds.map((id) => units.find((u) => u.id === id)).filter((u): u is Unit => !!u);
  const heldItems = [...new Set(held.map((u) => u.itemId))]
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  // What "add an item" can offer: anything with units, anything with
  // skills (covered by crew), or both.
  const trackedItems = items.filter((item) => item.skills.length > 0 || units.some((u) => u.itemId === item.id));
  const liveGigs = booking.gigs.filter((g) => g.status !== "Cancelled");
  const gigItems = [...new Set(liveGigs.map((g) => g.itemId))]
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  // Choices whose item is no longer on the booking's unit list at all (the
  // item was deleted, say) still get shown.
  const looseAddons = booking.addons.filter((a) => !heldItems.some((i) => i.id === a.itemId) && !gigItems.some((i) => i.id === a.itemId));

  const row = summary?.row ?? null;
  const money = summary?.money ?? null;
  const paper = summary?.paperwork ?? null;
  const next = row?.nextAction ?? null;
  const phoneDigits = (booking.phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const day = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const whenText = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const runNext = () => {
    if (!next) return;
    if (next.code === "send-pay-link") jump("booking-pay-link");
    else if (next.code === "send-contract") jump("booking-contract");
    else if (next.code === "wedding-details") jump("booking-wedding");
    else if (next.code === "assign-crew") go("/crew/gigs");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={`Booking for ${who}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>
              {who}
              <RushTag rush={booking.rush} cancelled={cancelled} />
            </h2>
            <span className="muted">
              Booking · {day(date)}
              {booking.eventTime ? `, ${booking.eventTime}` : ""} · <strong data-testid="booking-status">{row?.status ?? "Loading"}</strong>
              {row && row.needs.length > 0 ? ` · ${row.needs.map((n) => n.label).join(" · ")}` : ""}
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {flash && (
          <p className="bulk-result" role="status" data-testid="booking-flash">
            {flash}
          </p>
        )}
        {booking.rush && !cancelled && (
          <p className="rush-banner" role="note">
            <strong>RUSH.</strong> Booked with less than the minimum notice. It is confirmed in the system, but check with the
            customer and the crew before you count on it.
          </p>
        )}
        {booking.disputeFlaggedAt && (
          <p className="stage-warning" role="note">
            <strong>Payment disputed.</strong> The customer's bank has questioned a payment on this booking. See the payments under Money.
          </p>
        )}

        {notice && (
          <p className="form-error booking-notice" role="alert">
            {notice}
          </p>
        )}

        <div className="lead-popup-grid booking-popup-grid">
          <Part n={1} title="Who" help="The customer and how to reach them. Tap to call, text or email. Changes save when you leave a field.">
            <ContactLinks phone={phoneDigits.length === 10 ? phoneDigits : null} email={booking.email} />
            <Fact label="Customer name">
              <EditableCell value={who} ariaLabel={`Customer name for ${who}`} onSave={(customerName) => save({ customerName })} />
            </Fact>
            <Fact label="Phone">
              <EditableCell value={booking.phone ?? ""} placeholder="Add phone" ariaLabel={`Phone for ${who}`} onSave={(phone) => save({ phone })} />
            </Fact>
            <Fact label="Email">
              <EditableCell value={booking.email ?? ""} placeholder="Add email" ariaLabel={`Email for ${who}`} onSave={(email) => save({ email })} />
            </Fact>
            <label className="detail-field">
              <span className="detail-field-label">Lead</span>
              <select
                value={booking.leadId ?? ""}
                disabled={busy}
                aria-label={`Lead for ${who}`}
                onChange={(e) => run(() => updateBooking(booking.id, { leadId: e.target.value === "" ? null : e.target.value }))}
              >
                <option value="">No lead</option>
                {leads.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {leadLabel(lead)}
                  </option>
                ))}
              </select>
            </label>
            {booking.leadId && (
              <a className="muted field-help" href={`/leads?lead=${booking.leadId}`}>
                Open this customer's lead
              </a>
            )}
          </Part>

          <Part n={2} title="What and where" help="What is booked, when and where. Changing the date moves every item to a unit that is free that day, or changes nothing.">
            <div className="field-row">
              <Fact label="Event date">
                <EditableCell type="date" value={date} ariaLabel={`Event date for ${who}`} onSave={(eventDate) => save({ eventDate })} />
              </Fact>
              <Fact label="Time">
                <EditableCell value={booking.eventTime ?? ""} placeholder="Add time" ariaLabel={`Event time for ${who}`} onSave={(eventTime) => save({ eventTime: eventTime === "" ? null : eventTime })} />
              </Fact>
            </div>
            <div className="field-row">
              <Fact label="Occasion">{booking.occasion ?? "Not given"}</Fact>
              <Fact label="Guest count">{summary?.where.guestCount ?? "Not given"}</Fact>
            </div>
            <Fact label="Event address">
              <EditableCell value={booking.address ?? ""} placeholder="Add address" ariaLabel={`Address for ${who}`} onSave={(address) => save({ address: address === "" ? null : address })} />
              {bookingMapsUrl(booking) && (
                <a className="muted field-help" href={bookingMapsUrl(booking) ?? undefined} target="_blank" rel="noreferrer">
                  {booking.placeId && booking.addressCheck === "verified" ? "Open the exact place in Google Maps" : "Open the map"}
                </a>
              )}
            </Fact>
            {!booking.address && <Fact label="Setup notes">{summary?.where.setupNotes ?? "None"}</Fact>}
            <DeliverySection booking={booking} onChanged={refresh} />
            <div className="booking-items">
          <span className="detail-field-label">Items and units</span>
          {cancelled && <p className="muted">A cancelled booking holds no units. Set it back to Confirmed to add some.</p>}
          {!cancelled && heldItems.length === 0 && liveGigs.length === 0 && <p className="muted">No items on this booking yet.</p>}

          {heldItems.map((item) => (
            <BookingItemCard
              key={item.id}
              item={item}
              units={held.filter((u) => u.itemId === item.id)}
              addons={booking.addons.filter((a) => a.itemId === item.id)}
              busy={busy}
              onRemoveUnit={(unitId) => run(() => removeBookingUnit(booking.id, unitId))}
              onSetAddons={(addonIds) => run(() => setBookingAddons(booking.id, item.id, addonIds))}
            />
          ))}

          {gigItems.map((item) => (
            <BookingItemCard
              key={item.id}
              item={item}
              units={[]}
              gigs={liveGigs.filter((g) => g.itemId === item.id)}
              addons={booking.addons.filter((a) => a.itemId === item.id)}
              busy={busy}
              onRemoveUnit={() => {}}
              onRemoveGig={(gigId) => run(() => removeBookingGig(booking.id, gigId))}
              onSetAddons={(addonIds) => run(() => setBookingAddons(booking.id, item.id, addonIds))}
            />
          ))}
          {liveGigs.some((g) => !gigItems.some((i) => i.id === g.itemId)) && (
            <ul className="booking-addons">
              {liveGigs
                .filter((g) => !gigItems.some((i) => i.id === g.itemId))
                .map((g) => (
                  <li key={g.id}>
                    {g.itemName} <span className="muted">· needs a {g.skill} · {g.status}</span>
                  </li>
                ))}
            </ul>
          )}

          {looseAddons.length > 0 && (
            <ul className="booking-addons">
              {looseAddons.map((addon) => (
                <li key={addon.id}>
                  <span className="muted">{addon.itemName}</span> {describeAddon(addon)}
                </li>
              ))}
            </ul>
          )}

          {!cancelled && (
            <form
              className="booking-add-item"
              onSubmit={(e) => {
                e.preventDefault();
                if (addItemId === "") return;
                run(() => addBookingUnit(booking.id, addItemId));
              }}
            >
              <select value={addItemId} onChange={(e) => setAddItemId(e.target.value)} disabled={busy} aria-label="Item to add">
                <option value="">Add an item for this date…</option>
                {trackedItems.map((item) => {
                  const hasUnits = units.some((u) => u.itemId === item.id);
                  const crewNote = item.skills.length > 0 ? ` · needs ${item.skills.join(", ")}` : "";
                  if (!hasUnits) {
                    return (
                      <option key={item.id} value={item.id}>
                        {item.name} · crew{crewNote}
                      </option>
                    );
                  }
                  const free = freeCount(item, date, units, bookings);
                  return (
                    <option key={item.id} value={item.id} disabled={free === 0}>
                      {item.name} · {free === 0 ? "none free" : `${free} free`}
                      {crewNote}
                    </option>
                  );
                })}
              </select>
              <button type="submit" className="btn-secondary" disabled={busy || addItemId === ""}>
                Add a unit
              </button>
            </form>
          )}
          <p className="muted booking-help">
            Changing the date moves every item to a unit that's free on the new day, or changes nothing if one of them has
            none. Adding an item takes whichever of its units is free on this date; a service item takes a gig for the crew
            instead, if someone with the skill is free.
          </p>
            </div>
          </Part>

          <Part n={3} title="Money" help="What the booking costs, what has come in and what is owed. The app never charges a card: the customer pays from their pay link.">
            <div className="field-row">
              <Fact label="Total">{money ? (money.total === null ? "No price yet" : usd(money.total)) : booking.total !== null ? usd(Number(booking.total)) : "No price yet"}</Fact>
              <Fact label="Paid">{money ? usd(money.paid) : ""}</Fact>
            </div>
            <div className="field-row">
              <Fact label="Owed now">{money ? (money.owedNow === null ? "Nothing" : `${usd(money.owedNow)} (${money.owedStep === "balance" ? "balance" : "retainer"})`) : ""}</Fact>
              <Fact label="Balance due date">{money?.balanceDueDate ? `${day(money.balanceDueDate)}${money.balancePaid ? ", paid" : money.balance > 0 ? `, ${usd(money.balance)}` : ""}` : "No date yet"}</Fact>
            </div>
            <div id="booking-pay-link">
              <PayLinkControl bookingId={booking.id} refreshKey={stamp} onSent={refresh} />
            </div>
            <PaymentsSection bookingId={booking.id} onChanged={refresh} />
            <div className="status-control" role="group" aria-label={`Paid by hand for ${who}`}>
              <label className="checkbox-label">
                <input type="checkbox" checked={booking.retainerPaid} disabled={busy} onChange={(e) => run(() => updateBooking(booking.id, { retainerPaid: e.target.checked }))} />
                Retainer paid
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={booking.balancePaid} disabled={busy} onChange={(e) => run(() => updateBooking(booking.id, { balancePaid: e.target.checked }))} />
                Balance paid
              </label>
              <span className="muted field-help">Tick these only for money taken outside the app. A payment from the pay link ticks them on its own.</span>
              <label>
                <span className="detail-field-label">How the balance will be collected</span>
                <select
                  value={booking.balancePaymentPreference}
                  disabled={busy}
                  aria-label={`Balance payment preference for ${who}`}
                  onChange={(e) => run(() => updateBooking(booking.id, { balancePaymentPreference: e.target.value as BalancePreference }))}
                >
                  {BALANCE_PREFERENCES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <span className="muted field-help">A note for your team only. Nothing is charged or sent because of it.</span>
            </div>
            <RefundLog bookingId={booking.id} />
          </Part>

          <Part n={4} title="Paperwork" help={paper?.path === "contract" ? "This booking is on a contract: the customer signs it, then pays the retainer." : "This booking is on the short rental policy: the customer accepts it on the pay page, then pays the retainer."}>
            {paper && paper.path === "policy" && (
              <p className={paper.policy.by === "customer" ? "bulk-result" : "stage-warning"} role="note" data-testid="policy-line">
                {paper.policy.line}
              </p>
            )}
            {paper?.policy.acceptedText && (
              <details className="lead-more">
                <summary>The policy text the customer accepted</summary>
                <pre className="policy-text-shown">{paper.policy.acceptedText}</pre>
              </details>
            )}
            <div className="status-control" role="group" aria-label={`Contract for ${who}`} id="booking-contract">
              <span className="status-now">
                <span className="detail-field-label">Contract</span>
                <span className={booking.agreement?.contractStatus === "Signed" ? "achip achip-yes" : booking.agreement?.contractStatus === "Sent" ? "achip achip-unchecked" : "achip achip-none"}>
                  {booking.agreement?.contractStatus === "Signed" ? "Signed" : booking.agreement?.contractStatus === "Sent" ? "Sent, not signed" : paper?.path === "policy" ? "Not needed" : "Not sent"}
                </span>
              </span>
              {booking.agreement?.contractStatus === "Signed" && booking.agreement.contractUrl && (
                <a className="btn-secondary" href={booking.agreement.contractUrl} target="_blank" rel="noreferrer">
                  Open the signed PDF
                </a>
              )}
              {booking.agreement?.contractStatus !== "Signed" && (
                <a className="btn-secondary" href={`/api/contract-admin/preview/${booking.id}.pdf`} target="_blank" rel="noreferrer">
                  Preview the contract PDF
                </a>
              )}
              <SendMessageControls target={{ bookingId: booking.id }} label="Text the customer" onContractSent={refresh} />
              <span className="muted field-help">
                Send contract link texts and emails the signing link, states the retainer amount, and moves the booking to Contract Sent. Looking at the preview sends nothing. A signed contract is never sent again.
              </span>
            </div>
            <ContractDetails booking={booking} onSave={save} />
            <div id="booking-wedding">
              <WeddingDetailsPanel bookingId={booking.id} onChanged={refresh} />
            </div>
            <details className="lead-more">
              <summary>Stage and the agreement record</summary>
              <label>
                <span className="detail-field-label">Stage</span>
                <select value={booking.status} disabled={busy} aria-label={`Stage for ${who}`} onChange={(e) => run(() => updateBooking(booking.id, { status: e.target.value as BookingStatus }))}>
                  {(booking.status as string) === "Released" && (
                    <option value="Released" disabled>
                      Released (unpaid hold lapsed)
                    </option>
                  )}
                  {BOOKING_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <span className="muted field-help">
                The stage moves on its own when a contract is sent or signed. Change it here to correct it, to mark an event Completed, or to cancel a booking. Stage changes text the customer. Confirmed is worked out, not set: a small rental is
                Confirmed as soon as its retainer is paid, a contract booking when it is Signed and the retainer is paid. In the system this booking reads <BookingStatusTag booking={booking} />
                {booking.tier ? ` and is ${booking.tier === 1 ? "on the rental policy" : booking.tier === 2 ? "on a contract" : "a reviewed order"}` : ""}.
              </span>
              <AgreementDetail booking={booking} />
            </details>
          </Part>

          <Part n={5} title="History" help="What has happened on this booking and its lead, newest first, then every message sent and what is scheduled.">
            {summary && summary.history.length > 0 && (
              <ul className="activity-list">
                {summary.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="activity-entry">
                    <span className="activity-time">{whenText(h.at)}</span>
                    {h.text}
                    {h.by && <span className="muted"> · {h.by}</span>}
                  </li>
                ))}
              </ul>
            )}
            <RecordMessages bookingId={booking.id} />
            <AutomationTimeline kind="booking" id={booking.id} />
          </Part>

          <Part n={6} title="Next action" help={row ? (row.needs.length > 0 ? `This booking is waiting on: ${row.needs.map((n) => n.label).join(", ")}. The button is the next thing to do.` : "Nothing is waiting on this booking.") : "What to do next."}>
            {next && next.code === "decide-cancellation" && (booking.leadId ? <CancellationRequests leadId={booking.leadId} onDecided={refresh} /> : <a href="/leads?view=cancellations">Open the cancellation request in Leads</a>)}
            {next && next.code !== "none" && next.code !== "decide-cancellation" && (
              <button type="button" className="btn-primary lead-main-action" onClick={runNext} data-testid="booking-main-action">
                {next.label}
              </button>
            )}
            {next && next.code === "none" && <p className="muted">{next.label}</p>}
            {next && (next.code === "send-pay-link" || next.code === "send-contract" || next.code === "wedding-details") && (
              <span className="muted field-help">
                {next.code === "send-pay-link" ? "Takes you to the pay link under Money, where you confirm the amount before it is sent." : next.code === "send-contract" ? "Takes you to the contract under Paperwork, where you send the link." : "Takes you to the wedding details under Paperwork."}
              </span>
            )}
          </Part>
        </div>

        <div className="modal-foot">
          <span className="muted">Changes save as you go.</span>
          <button type="button" className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingItemCard({
  item,
  units,
  gigs = [],
  addons,
  busy,
  onRemoveUnit,
  onRemoveGig,
  onSetAddons,
}: {
  item: Item;
  units: Unit[];
  gigs?: BookingGig[];
  addons: BookingAddon[];
  busy: boolean;
  onRemoveUnit: (unitId: string) => void;
  onRemoveGig?: (gigId: string) => void;
  onSetAddons: (addonIds: string[]) => void;
}) {
  const liveIds = new Set(item.addonGroups.flatMap((g) => g.addons.map((a) => a.id)));
  const chosenIn = (group: AddonGroup) => addons.find((a) => a.addonId && group.addons.some((o) => o.id === a.addonId));
  // Chosen when booked, but the option has since been removed from the
  // item. Kept as the record; it can't be picked again.
  const retired = addons.filter((a) => !a.addonId || !liveIds.has(a.addonId));

  function pick(group: AddonGroup, addonId: string) {
    const others = item.addonGroups
      .filter((g) => g.id !== group.id)
      .map((g) => chosenIn(g)?.addonId)
      .filter((id): id is string => !!id);
    onSetAddons(addonId === "" ? others : [...others, addonId]);
  }

  return (
    <div className="addon-group booking-item">
      <div className="booking-item-head">
        <strong>{item.name}</strong>
        <span className="muted">{item.price !== null ? usd(Number(item.price)) : "TBD"}</span>
      </div>
      <div className="booking-units">
        {gigs.map((gig) => (
          <span key={gig.id} className="tag-chip">
            {gig.filledBy ? `${gig.filledBy.name} (${gig.skill})` : `Needs a ${gig.skill}`}
            <span className="muted"> · {gig.status}</span>
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove the ${gig.skill} gig for ${item.name} from this booking`}
              disabled={busy}
              onClick={() => onRemoveGig?.(gig.id)}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {units.map((unit) => (
          <span key={unit.id} className="tag-chip">
            {unit.label}
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove ${item.name} ${unit.label} from this booking`}
              disabled={busy}
              onClick={() => onRemoveUnit(unit.id)}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>

      {item.addonGroups.length > 0 && (
        <div className="booking-item-addons">
          {item.addonGroups.map((group) => {
            const chosen = chosenIn(group);
            return (
              <label key={group.id}>
                <span className="booking-addon-label">
                  {group.name}
                  {group.required && !chosen && <span className="booking-addon-missing"> · required, not chosen</span>}
                </span>
                <select
                  value={chosen?.addonId ?? ""}
                  disabled={busy || group.addons.length === 0}
                  aria-label={`${group.name} for ${item.name}`}
                  onChange={(e) => pick(group, e.target.value)}
                >
                  <option value="">None</option>
                  {group.addons.map((option) => {
                    const delta = deltaLabel(option.priceDelta);
                    return (
                      <option key={option.id} value={option.id}>
                        {option.name}
                        {delta ? ` (${delta})` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            );
          })}
        </div>
      )}

      {retired.length > 0 && (
        <ul className="booking-addons">
          {retired.map((addon) => (
            <li key={addon.id}>
              {describeAddon(addon)} <span className="muted">· chosen at booking, no longer offered</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The details behind the chip: when, which version, whether the box was
// ticked, and the exact text of that version on request. The contract
// fields stay empty until the signed-contract integration exists.
function AgreementDetail({ booking }: { booking: Booking }) {
  const agreement = booking.agreement;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!agreement) {
    return <span className="muted field-help">This booking was made before agreements were recorded.</span>;
  }
  const versionId = agreement.policyVersion.id;
  async function show() {
    setError(null);
    try {
      const policy = await getPolicy();
      setText(policy.versions.find((v) => v.id === versionId)?.text ?? "(not found)");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the policy");
    }
  }
  return (
    <div className="agreement-detail">
      <span className="muted">
        {agreement.checkboxChecked ? "Box ticked" : "Box not ticked"} ·{" "}
        {new Date(agreement.agreedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" })}{" "}
        Eastern · policy version {agreement.policyVersion.version}
        {agreement.contractStatus ? ` · contract ${agreement.contractStatus}` : ""}
      </span>{" "}
      {text === null ? (
        <button type="button" className="btn-secondary" onClick={show}>
          Show the text they saw
        </button>
      ) : (
        <>
          <button type="button" className="btn-secondary" onClick={() => setText(null)}>
            Hide
          </button>
          <pre className="policy-text-shown">{text === "" ? "(that version had no text)" : text}</pre>
        </>
      )}
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}
