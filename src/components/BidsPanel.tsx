import { useEffect, useMemo, useState } from "react";
import { extendGigDeadline, inviteGigBids, previewGigInvite, updateGigDetails, updateGigOffer } from "../lib/api";
import type { GigDetail, GigOffer } from "../lib/types";
import { SendMessageControls } from "./SendMessageControls";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// datetime-local wants "YYYY-MM-DDTHH:mm" in the computer's own clock.
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function offerLabel(o: GigOffer): string {
  switch (o.bidState) {
    case "accepted":
      return "Accepted";
    case "not_selected":
      return "Not selected";
    case "declined":
      return "Declined";
    case "bid_submitted":
      return "Bid in";
    case "expired":
      return "Invited, closed";
    default:
      return "Invited";
  }
}

type Details = { payMin: string; payMax: string; town: string; eventType: string; guestCount: string; startTime: string; endTime: string; arrivalNotes: string };

function detailsFrom(g: GigDetail): Details {
  const pre = g.prefill;
  return {
    payMin: g.payMin?.toString() ?? "",
    payMax: g.payMax?.toString() ?? "",
    town: g.town ?? pre?.town ?? "",
    eventType: g.eventType ?? pre?.eventType ?? "",
    guestCount: g.guestCount?.toString() ?? "",
    startTime: g.startTime ?? pre?.startTime ?? "",
    endTime: g.endTime ?? pre?.endTime ?? "",
    arrivalNotes: g.arrivalNotes ?? "",
  };
}

// Inviting crew to bid on a gig, and picking from the bids. All the rules
// (deadline, who wins, who is told) are on the server; this only shows them.
export function BidsPanel({ gig, busy, run, setNotice }: { gig: GigDetail; busy: boolean; run: (action: () => Promise<GigDetail>, done?: (d: GigDetail) => string) => Promise<void>; setNotice: (s: string | null) => void }) {
  const [d, setD] = useState<Details>(() => detailsFrom(gig));
  const [deadline, setDeadline] = useState(() => localInput(new Date(Date.now() + 48 * 3_600_000)));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ text: string; problem: string | null } | null>(null);
  const [extendTo, setExtendTo] = useState(() => localInput(new Date(Date.now() + 24 * 3_600_000)));
  const [localError, setLocalError] = useState<string | null>(null);

  // Start from what the gig and booking hold, once the detail has loaded.
  useEffect(() => {
    setD(detailsFrom(gig));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gig.id]);

  const offeredIds = new Set(gig.offers.map((o) => o.crewMemberId));
  const legacy = new Set(gig.offers.filter((o) => o.status === "Sent" && !o.token).map((o) => o.crewMemberId));
  const invitable = gig.candidates.filter((c) => !offeredIds.has(c.id) || legacy.has(c.id));
  const filled = gig.status === "Filled";

  function body() {
    const n = (s: string) => (s.trim() === "" ? null : Number(s));
    const min = n(d.payMin);
    const max = n(d.payMax);
    if (min === null || max === null || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min > max) {
      setLocalError("Set both ends of the pay range in whole dollars, minimum not above maximum.");
      return null;
    }
    if (!d.town.trim()) {
      setLocalError("Set the town. The invite and the bid page both name it.");
      return null;
    }
    const at = new Date(deadline);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      setLocalError("The deadline has to be in the future.");
      return null;
    }
    setLocalError(null);
    return {
      payMin: min,
      payMax: max,
      deadlineAt: at.toISOString(),
      fields: {
        town: d.town.trim(),
        eventType: d.eventType.trim(),
        startTime: d.startTime.trim(),
        endTime: d.endTime.trim(),
        arrivalNotes: d.arrivalNotes.trim(),
        ...(d.guestCount.trim() !== "" ? { guestCount: Number(d.guestCount) } : {}),
      },
    };
  }

  async function showPreview() {
    const b = body();
    if (!b) return;
    setNotice(null);
    try {
      setPreview(await previewGigInvite(gig.id, b));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Couldn't build the preview");
    }
  }

  function send() {
    const b = body();
    if (!b) return;
    void run(
      () => inviteGigBids(gig.id, { ...b, crewMemberIds: [...picked] }),
      (detail) => {
        const r = detail as unknown as { offered: number; messages: { status: string }[] };
        const sent = r.messages.filter((m) => m.status === "sent").length;
        const held = r.messages.length - sent;
        setPicked(new Set());
        setPreview(null);
        return `Invited ${r.offered} ${r.offered === 1 ? "person" : "people"}. ${sent} ${sent === 1 ? "text was" : "texts were"} sent` + (held > 0 ? `; ${held} could not go out (see Messages, Sent log, for why)` : "") + ".";
      },
    );
  }

  const bids = useMemo(
    () =>
      [...gig.offers].sort((a, b) => {
        if (a.bidAmount !== null && b.bidAmount !== null) return a.bidAmount - b.bidAmount;
        if (a.bidAmount !== null) return -1;
        if (b.bidAmount !== null) return 1;
        return a.crewMember.name.localeCompare(b.crewMember.name);
      }),
    [gig.offers],
  );

  function accept(o: GigOffer) {
    const amount = o.bidAmount !== null ? ` at ${usd(o.bidAmount)}` : "";
    const others = gig.offers.filter((x) => x.id !== o.id && x.status === "Sent").length;
    const tail = others > 0 ? ` The ${others} other ${others === 1 ? "person" : "people"} still in the running will get a "not selected" text.` : "";
    if (!window.confirm(`Accept ${o.crewMember.name}${amount}?${tail} ${o.crewMember.name.split(" ")[0]} gets a text with the address and details.`)) return;
    void run(() => updateGigOffer(gig.id, o.id, "Accepted"), () => `${o.crewMember.name} accepted. The gig is filled and the texts are going out.`);
  }

  function extend() {
    const at = new Date(extendTo);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      setLocalError("The new deadline has to be in the future.");
      return;
    }
    setLocalError(null);
    void run(() => extendGigDeadline(gig.id, at.toISOString()), () => `Deadline moved to ${stamp(at.toISOString())} Eastern for everyone still bidding.`);
  }

  const openOffers = gig.offers.filter((o) => o.status === "Sent" && o.token);
  const field = (label: string, key: keyof Details, props: { placeholder?: string; type?: string; width?: number } = {}) => (
    <label className="detail-field" style={{ minWidth: props.width ?? 140 }}>
      <span className="detail-field-label">{label}</span>
      <input type={props.type ?? "text"} value={d[key]} placeholder={props.placeholder} disabled={busy} onChange={(e) => setD((prev) => ({ ...prev, [key]: e.target.value }))} />
    </label>
  );

  return (
    <>
      <div className="modal-section">
        <span className="detail-field-label">What crew see on the bid page</span>
        <p className="muted addon-help">Filled in from the booking where it had the data (guest count is never on a booking, so type it). Crew see the town only, never the street address, until they are picked.</p>
        <div className="bids-fields">
          {field("Pay min ($)", "payMin", { type: "number", width: 100 })}
          {field("Pay max ($)", "payMax", { type: "number", width: 100 })}
          {field("Town", "town")}
          {field("Event type", "eventType")}
          {field("Guests", "guestCount", { type: "number", width: 90 })}
          {field("Start", "startTime", { placeholder: "2 PM", width: 90 })}
          {field("End", "endTime", { placeholder: "6 PM", width: 90 })}
        </div>
        <label className="detail-field">
          <span className="detail-field-label">Arrival notes (shown only after they are picked)</span>
          <textarea rows={2} value={d.arrivalNotes} disabled={busy} maxLength={1000} onChange={(e) => setD((prev) => ({ ...prev, arrivalNotes: e.target.value }))} />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  updateGigDetails(gig.id, {
                    payMin: d.payMin.trim() === "" ? null : Number(d.payMin),
                    payMax: d.payMax.trim() === "" ? null : Number(d.payMax),
                    town: d.town.trim() || null,
                    eventType: d.eventType.trim() || null,
                    guestCount: d.guestCount.trim() === "" ? null : Number(d.guestCount),
                    startTime: d.startTime.trim() || null,
                    endTime: d.endTime.trim() || null,
                    arrivalNotes: d.arrivalNotes.trim() || null,
                  }),
                () => "Saved.",
              )
            }
          >
            Save details
          </button>
        </div>
      </div>

      {!filled && (
        <div className="modal-section">
          <span className="detail-field-label">Invite bids</span>
          {invitable.length === 0 ? (
            <p className="muted">{gig.candidates.length === 0 ? `Nobody active on the crew has the ${gig.skill} skill. Add someone under Crew first.` : "Everyone with this skill has already been invited."}</p>
          ) : (
            <>
              <p className="muted addon-help">Active crew with the {gig.skill} skill. Each person gets a text with their own link to bid.</p>
              <ul className="addon-list">
                {invitable.map((m) => (
                  <li key={m.id} className="crew-candidate">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={picked.has(m.id)}
                        disabled={busy}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(m.id);
                            else next.delete(m.id);
                            return next;
                          })
                        }
                      />
                      {m.name}
                    </label>
                    <span className="muted">
                      {m.phone ?? "No phone"}
                      {!m.smsConsent && <span className="stage-warning"> · No text consent on file. Confirm they agreed to be texted (Crew, their record).</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <label className="detail-field">
                <span className="detail-field-label">Bid deadline (your computer's clock)</span>
                <input type="datetime-local" value={deadline} disabled={busy} onChange={(e) => setDeadline(e.target.value)} />
              </label>
              {localError && <p className="form-error">{localError}</p>}
              {preview && (
                <div className="bulk-result" role="status">
                  <strong>Invite text</strong>
                  <p>{preview.text}</p>
                  {preview.problem && <p className="form-error">Would be blocked: {preview.problem}</p>}
                </div>
              )}
              <div className="form-actions">
                <button type="button" className="btn-secondary" disabled={busy} onClick={showPreview}>
                  Preview the text
                </button>
                <button type="button" className="btn-primary" disabled={busy || picked.size === 0} onClick={send}>
                  Send invites ({picked.size})
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="modal-section">
        <span className="detail-field-label">Bids</span>
        {gig.offers.length === 0 ? (
          <p className="muted">Nobody has been invited yet.</p>
        ) : (
          <>
            {gig.payMin !== null && gig.payMax !== null && (
              <p className="muted addon-help">
                Range {usd(gig.payMin)} to {usd(gig.payMax)}. Lowest bid first. Bids outside the range are allowed and flagged.
              </p>
            )}
            <ul className="addon-list">
              {bids.map((o) => (
                <li key={o.id} className="crew-offer bids-row">
                  <span>
                    <strong>{o.crewMember.name}</strong>
                    {!o.crewMember.active && <span className="muted"> · inactive</span>}
                  </span>
                  <span className={o.bidState === "accepted" ? "status-pill status-pill-live" : "status-pill"}>{offerLabel(o)}</span>
                  {o.bidAmount !== null && (
                    <span>
                      <strong>{usd(o.bidAmount)}</strong>
                      {o.rangeFlag && <span className="stage-warning"> {o.rangeFlag}</span>}
                    </span>
                  )}
                  {o.bidNote && <span className="muted">"{o.bidNote}"</span>}
                  {o.bidSubmittedAt && <span className="muted">bid {stamp(o.bidSubmittedAt)}</span>}
                  {o.deadlineAt && o.status === "Sent" && <span className="muted">deadline {stamp(o.deadlineAt)}</span>}
                  {o.status === "Accepted" && (
                    <span className="muted">{o.confirmedAt ? `I'm set, confirmed ${stamp(o.confirmedAt)}` : "Hasn't confirmed yet"}</span>
                  )}
                  {o.questions.length > 0 && (
                    <ul className="bids-questions">
                      {o.questions.map((q) => (
                        <li key={q.id}>
                          <span className="muted">{stamp(q.createdAt)}:</span> {q.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  <span className="form-actions">
                    {o.status !== "Accepted" && (
                      <button type="button" className="btn-primary" disabled={busy || filled} title={filled ? "Decline the current pick first" : undefined} onClick={() => accept(o)}>
                        Accept
                      </button>
                    )}
                    <SendMessageControls target={{ crewMemberId: o.crewMemberId }} contract={false} />
                    {o.status !== "Declined" && o.status !== "Not Selected" && (
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => updateGigOffer(gig.id, o.id, "Declined"))}>
                        {o.status === "Accepted" ? "Take back" : "Mark declined"}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {openOffers.length > 0 && !filled && (
              <div className="form-actions">
                <label className="detail-field">
                  <span className="detail-field-label">Extend the deadline for everyone still bidding</span>
                  <input type="datetime-local" value={extendTo} disabled={busy} onChange={(e) => setExtendTo(e.target.value)} />
                </label>
                <button type="button" className="btn-secondary" disabled={busy} onClick={extend}>
                  Extend deadline
                </button>
              </div>
            )}
            {localError && !preview && <p className="form-error">{localError}</p>}
          </>
        )}
      </div>
    </>
  );
}
