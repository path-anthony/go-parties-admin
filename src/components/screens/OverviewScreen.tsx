import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBookings, getDesignRequests, getMessageSummary, getGigs, getLeadStatuses, getLeads, getMoneyOverview } from "../../lib/api";
import { formatEventDay } from "../../lib/gigs";
import { FOLLOW_UP_DAYS, PROPOSAL_FOLLOW_UP_DAYS, daysSinceUpdate, findStage, needsFollowUp, useNavigate } from "../../lib/navigation";
import type { Booking, DesignRequest, MessageSummary, Gig, Lead, MoneyOverview } from "../../lib/types";
import { displayStatus, isInactiveStage } from "../../lib/bookingStatus";
import { AgreementChip, BalanceLabel } from "../AgreementChip";
import { BookingStatusTag } from "../BookingStatusTag";
import { RushTag } from "../RushTag";
import { StatCard, StatGrid } from "../StatCard";

// What is not measured yet, and what each one is waiting on, so the
// dashes read as a plan rather than a gap.
const NOT_TRACKED = [
  { label: "Sales this month", waitingOn: "Waiting on payment integration: bookings carry a quoted total, nothing records money received." },
  { label: "Upcoming events (30d)", waitingOn: "Waiting on the calendar view of Scheduling, which counts confirmed events by date." },
  { label: "Contract signed", waitingOn: "Waiting on the e-sign integration (SignWell or Documenso, not yet chosen)." },
  { label: "Retainer status", waitingOn: "Waiting on payment integration: retainer links are not sent or recorded yet." },
];

const NEAREST_GIGS = 3;

// The day as a plain YYYY-MM-DD, for comparing event dates to today.
// Eastern time, the business's day: the UTC day rolls over at 8pm Eastern
// and would drop tonight's gigs from "upcoming" a few hours early.
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export function OverviewScreen() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [statuses, setStatuses] = useState<string[] | null>(null);
  const [needsCrew, setNeedsCrew] = useState<Gig[] | null>(null);
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [requests, setRequests] = useState<DesignRequest[] | null>(null);
  const [messages, setMessages] = useState<MessageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getLeads(), getLeadStatuses(), getGigs("Needs Crew"), getBookings(), getDesignRequests("Open"), getMessageSummary()])
      .then(([leadList, rows, gigs, bookingList, requestList, messageSummary]) => {
        setRequests(requestList);
        setMessages(messageSummary);
        setLeads(leadList);
        setStatuses(rows.map((row) => row.name));
        setNeedsCrew(gigs);
        setBookings(bookingList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, []);

  const ready = leads !== null && statuses !== null && needsCrew !== null && bookings !== null && requests !== null && messages !== null;

  // The well-known stages, found by name in the configurable columns.
  const stageNew = statuses ? findStage(statuses, "New") : undefined;
  const stageContacted = statuses ? findStage(statuses, "Contacted") : undefined;
  const stageBooked = statuses ? findStage(statuses, "Booked") : undefined;
  const earlyStages = [stageNew, stageContacted].filter((s): s is string => !!s);
  const countIn = (stage: string | undefined) => (stage ? (leads ?? []).filter((l) => l.status === stage).length : 0);
  const followUps = (leads ?? []).filter((l) => needsFollowUp(l, earlyStages));
  // One row per column, except Proposal sent, which splits into the
  // proposals still fresh and the ones that have sat 5+ days without a
  // touch. Same last-updated clock as the follow-up card; any edit resets
  // it.
  const stageProposal = statuses ? findStage(statuses, "Proposal sent") : undefined;
  const byStage = (statuses ?? []).flatMap((name) => {
    if (name !== stageProposal) return [{ key: name, label: name, count: countIn(name), status: name, staleDays: undefined as number | undefined }];
    const inStage = (leads ?? []).filter((l) => l.status === name);
    const stale = inStage.filter((l) => daysSinceUpdate(l) >= PROPOSAL_FOLLOW_UP_DAYS);
    return [
      { key: `${name}:recent`, label: "Proposal sent", count: inStage.length - stale.length, status: name, staleDays: undefined },
      { key: `${name}:stale`, label: "Needs follow-up", count: stale.length, status: name, staleDays: PROPOSAL_FOLLOW_UP_DAYS },
    ];
  });
  const maxStage = Math.max(1, ...byStage.map((s) => s.count));

  const upcoming = (needsCrew ?? []).filter((g) => g.eventDate.slice(0, 10) >= today());
  // Rush bookings still to come, soonest first (the list is already by date).
  const rushBookings = (bookings ?? []).filter((b) => b.rush && !isInactiveStage(b.status) && b.eventDate.slice(0, 10) >= today());
  // Upcoming bookings by what they read as, so Held ones can't hide.
  const liveUpcoming = (bookings ?? []).filter((b) => !isInactiveStage(b.status) && b.status !== "Completed" && b.eventDate.slice(0, 10) >= today());
  const byStatus = (status: string) => liveUpcoming.filter((b) => displayStatus(b) === status).length;
  const nearest = (upcoming.length > 0 ? upcoming : (needsCrew ?? [])).slice(0, NEAREST_GIGS);

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Overview</h2>
        <p className="muted">What needs attention today. Every number opens the view behind it.</p>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!ready && !error && <p className="muted">Loading…</p>}

      <MoneySections />

      {ready && (
        <>
          <section className="kpi-section kpi-section-leads">
            <span className="kpi-section-label">Leads</span>
            <StatGrid className="kpi-grid-leads">
              <StatCard
                label="New leads"
                value={countIn(stageNew)}
                note={stageNew ? "Opens the New column" : "No column named New"}
                onClick={stageNew ? () => navigate("leads", { leadStatus: stageNew }) : undefined}
              />
              <StatCard
                label="Contacted"
                value={countIn(stageContacted)}
                note={stageContacted ? "Opens the Contacted column" : "No column named Contacted"}
                onClick={stageContacted ? () => navigate("leads", { leadStatus: stageContacted }) : undefined}
              />
              <StatCard
                label="Follow up needed"
                value={followUps.length}
                note={`New or Contacted, untouched for ${FOLLOW_UP_DAYS}+ days`}
                onClick={earlyStages.length > 0 ? () => navigate("leads", { leadFollowUp: true }) : undefined}
              />
              <StatCard
                label="Booked"
                value={countIn(stageBooked)}
                note={stageBooked ? "Opens the Booked column" : "No column named Booked"}
                onClick={stageBooked ? () => navigate("leads", { leadStatus: stageBooked }) : undefined}
              />
            </StatGrid>

            <div className="stage-block">
              <span className="kpi-label">Leads by stage</span>
              <ul className="stage-bars" aria-label="Leads by stage">
                {byStage.map(({ key, label, count, status, staleDays }) => (
                  <li key={key}>
                    <button
                      type="button"
                      className="stage-bar"
                      title={staleDays ? `Proposals untouched for ${staleDays}+ days` : undefined}
                      onClick={() => navigate("leads", { leadStatus: status, leadStaleDays: staleDays })}
                    >
                      <span className="stage-bar-name">{label}</span>
                      <span className="stage-bar-track" aria-hidden="true">
                        <span className="stage-bar-fill" style={{ width: `${Math.round((count / maxStage) * 100)}%` }} />
                      </span>
                      <span className="stage-bar-count">{count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="kpi-section">
            <span className="kpi-section-label">Booking status</span>
            <StatGrid>
              {(["Held", "Contract Sent", "Signed", "Retainer Paid", "Confirmed"] as const).map((status) => (
                <StatCard
                  key={status}
                  label={status}
                  value={byStatus(status)}
                  note={status === "Confirmed" ? "Retainer paid, and signed when a contract is needed" : "Upcoming bookings"}
                  onClick={() => navigate("scheduling")}
                />
              ))}
            </StatGrid>
          </section>

          <section className="kpi-section">
            <span className="kpi-section-label">Messages</span>
            <StatGrid>
              {(
                [
                  ["Texts, last 7 days", messages.sms],
                  ["Emails, last 7 days", messages.email],
                ] as const
              ).map(([label, m]) => (
                <StatCard
                  key={label}
                  label={label}
                  value={m.total}
                  note={`${m.sent} sent, ${m.delivered} delivered (n8n), ${m.failed} failed, ${m.skipped} skipped`}
                  onClick={() => navigate("messages")}
                />
              ))}
            </StatGrid>
          </section>

          <section className="kpi-section">
            <span className="kpi-section-label">Design requests</span>
            <div className="crew-card">
              <div className="crew-card-head">
                <div>
                  <span className="kpi-label">Waiting for review</span>
                  <span className="kpi-value">{requests.length}</span>
                </div>
                <button type="button" className="btn-secondary" onClick={() => navigate("requests")}>
                  Open Design requests
                </button>
              </div>
              {requests.length === 0 ? (
                <p className="muted">Nothing is waiting. Weddings, corporate events and big carts show up here.</p>
              ) : (
                <ul className="crew-card-list" aria-label="Design requests waiting">
                  {requests.slice(0, NEAREST_GIGS).map((r) => (
                    <li key={r.id}>
                      <button type="button" className="crew-card-row" onClick={() => navigate("requests")}>
                        <span className="kpi-list-when">{formatEventDay(r.eventDate)}</span>
                        <span className="crew-card-customer">{r.customerName}</span>
                        <span className="muted">{r.total === null ? "no price" : r.total.toLocaleString("en-US", { style: "currency", currency: "USD" })}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="kpi-section">
            <span className="kpi-section-label">Rush</span>
            <div className="crew-card">
              <div className="crew-card-head">
                <div>
                  <span className="kpi-label">Rush bookings coming up</span>
                  <span className="kpi-value">{rushBookings.length}</span>
                </div>
                <button type="button" className="btn-secondary" onClick={() => navigate("scheduling")}>
                  Open Scheduling
                </button>
              </div>
              {rushBookings.length === 0 ? (
                <p className="muted">Nothing booked inside the minimum notice window.</p>
              ) : (
                <ul className="crew-card-list" aria-label="Rush bookings">
                  {rushBookings.slice(0, NEAREST_GIGS).map((b) => (
                    <li key={b.id}>
                      <button type="button" className="crew-card-row" onClick={() => navigate("scheduling")}>
                        <span className="kpi-list-when">{formatEventDay(b.eventDate)}</span>
                        <span className="crew-card-customer">
                          {b.customerName} <BookingStatusTag booking={b} /> <AgreementChip agreement={b.agreement} />
                          <RushTag rush={b.rush} /> <BalanceLabel preference={b.balancePaymentPreference} />
                        </span>
                        <span className="muted">{b.eventTime ?? "no time set"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="kpi-section">
            <span className="kpi-section-label">Crew</span>
            <div className="crew-card">
              <div className="crew-card-head">
                <div>
                  <span className="kpi-label">Bookings needing crew</span>
                  <span className="kpi-value">{needsCrew.length}</span>
                </div>
                <button type="button" className="btn-secondary" onClick={() => navigate("crew", { gigStatus: "Needs Crew" })}>
                  View all ({needsCrew.length})
                </button>
              </div>
              {nearest.length === 0 ? (
                <p className="muted">Every booked service item has someone on it.</p>
              ) : (
                <ul className="crew-card-list" aria-label="Nearest gigs needing crew">
                  {nearest.map((g) => (
                    <li key={g.id}>
                      <button type="button" className="crew-card-row" onClick={() => navigate("crew", { gigStatus: "Needs Crew", gigId: g.id })}>
                        <span className="kpi-list-when">{formatEventDay(g.eventDate)}</span>
                        <span className="crew-card-customer">
                          {g.booking.customerName} <BookingStatusTag booking={g.booking} /> <AgreementChip agreement={g.booking.agreement} />
                          <RushTag rush={g.booking.rush} cancelled={isInactiveStage(g.booking.status)} />
                        </span>
                        <span className="muted">needs a {g.skill}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}

      <section className="kpi-section">
        <span className="kpi-section-label">Not yet tracked</span>
        <StatGrid>
          {NOT_TRACKED.map(({ label, waitingOn }) => (
            <StatCard key={label} label={label} value="--" placeholder note={waitingOn} />
          ))}
        </StatGrid>
      </section>
    </div>
  );
}

// Block F1. Two plain lists: what came in over the last week, and what is
// still owed. Every row opens its booking. Kept simple on purpose; the next
// block restyles the admin screens.
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDay = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const paidWhen = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const bookingHref = (id: string) => `/scheduling/bookings?booking=${id}`;

function MoneySections() {
  const [data, setData] = useState<MoneyOverview | null>(null);
  useEffect(() => {
    let current = true;
    getMoneyOverview()
      .then((d) => current && setData(d))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  if (!data) return null;
  const { moneyIn, waiting } = data;
  return (
    <>
      <section className="kpi-section" aria-label="Money in" data-testid="money-in">
        <span className="kpi-section-label">Money in</span>
        <p className="muted">
          Payments received in the last {moneyIn.days} days: <strong>{money(moneyIn.totalCents)}</strong> from {moneyIn.payments.length} {moneyIn.payments.length === 1 ? "payment" : "payments"}.
        </p>
        {moneyIn.payments.length > 0 && (
          <ul className="crew-card-list">
            {moneyIn.payments.map((p) => (
              <li key={p.id}>
                <Link className="crew-card-row" style={{ color: "inherit", textDecoration: "none" }} to={bookingHref(p.bookingId)}>
                  <span className="kpi-list-when">{paidWhen(p.paidAt)}</span>
                  <span className="crew-card-customer">
                    {p.customerName} · {money(p.amountCents)} {p.kind} · {p.method === "card" ? "card" : `${p.method}, recorded by staff`}
                  </span>
                  <span className="muted">event {shortDay(p.eventDate)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="kpi-section" aria-label="Waiting on payment" data-testid="waiting-on-payment">
        <span className="kpi-section-label">Waiting on payment</span>
        <p className="muted">
          Retainers not paid yet ({waiting.retainers.length}), and balances due in the next {waiting.balanceDays} days or already late ({waiting.balances.length}).
        </p>
        {waiting.retainers.length + waiting.balances.length > 0 && (
          <ul className="crew-card-list">
            {waiting.retainers.map((r) => (
              <li key={`r:${r.bookingId}`}>
                <Link className="crew-card-row" style={{ color: "inherit", textDecoration: "none" }} to={bookingHref(r.bookingId)}>
                  <span className="kpi-list-when">Retainer {money(r.amountCents)}</span>
                  <span className="crew-card-customer">
                    {r.customerName} · event {shortDay(r.eventDate)} · {r.status}
                  </span>
                  <span className="muted">{r.needsSignature ? "contract not signed yet" : r.payLinkSentAt ? `pay link sent ${shortDay(r.payLinkSentAt)}` : "pay link not sent"}</span>
                </Link>
              </li>
            ))}
            {waiting.balances.map((b) => (
              <li key={`b:${b.bookingId}`}>
                <Link className="crew-card-row" style={{ color: "inherit", textDecoration: "none" }} to={bookingHref(b.bookingId)}>
                  <span className="kpi-list-when">Balance {money(b.amountCents)}</span>
                  <span className="crew-card-customer">
                    {b.customerName} · event {shortDay(b.eventDate)}
                  </span>
                  <span className="muted">{b.overdue ? `was due ${shortDay(b.dueDate)}` : `due ${shortDay(b.dueDate)}`}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
