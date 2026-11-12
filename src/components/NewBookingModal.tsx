import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { checkStaffAddress, createStaffBooking, getAvailableItems, getInbox, getItems, getPackages, previewStaffBooking, searchCustomers } from "../lib/api";
import { deltaLabel } from "../lib/addons";
import { BALANCE_PREFERENCES, type BalancePreference } from "../lib/bookingStatus";
import { useNavigate } from "../lib/navigation";
import { OCCASION_GROUPS } from "../lib/occasions";
import type { AvailableItem, CustomerMatch, DesignRequest, InboxRow, Item, LeadPrefill, Package, StaffAddressCheck, StaffBookingResult, StaffPreview } from "../lib/types";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const todayEastern = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const longDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const MAX_LIST = 30;

const STEPS = [
  { n: 1, title: "Who", help: "Pick a lead or a customer you already have, or type in someone new." },
  { n: 2, title: "What and when", help: "The date and time first, then what they want. Only what is free that day can be picked." },
  { n: 3, title: "Review and send", help: "Check the total and what the customer will be sent, then create the booking." },
] as const;

// What was sent, in one line, for the booking popup to show after creating.
function sentLine(result: Extract<StaffBookingResult, { bookingId: string }>, asked: boolean): string {
  if (!asked) return "Booking created. Nothing was sent to the customer. Use Send pay link on this booking when you are ready.";
  const pay = result.payLink;
  if (!pay) return "Booking created.";
  const amount = pay.amountCents === null ? "" : usd(pay.amountCents / 100);
  if (!pay.sent) return `Booking created. Nothing was sent: ${pay.why ?? "there was nothing to send"}. Use Send pay link on this booking to try again.`;
  const to = (pay.sentTo ?? []).map((m) => `${m.channel === "sms" ? "text" : "email"} to ${m.to}`);
  const where = to.length > 0 ? ` by ${to.join(" and by ")}` : "";
  return pay.step === "sign" ? `Booking created. The contract link was sent${where}. It says the retainer is ${amount}; the pay link follows when they sign.` : `Booking created. The pay link for the ${pay.step === "balance" ? "balance" : "retainer"} of ${amount} was sent${where}.`;
}

// Block F3b. A booking taken for a customer by phone or in person, in three
// steps: Who, What and when, Review and send. It sends the same request the
// storefront does to the same booking code, so the server takes the same unit
// and crew locks, applies the same review rules and decides policy or contract
// the same way. Nothing here names an amount the server trusts except the
// quoted total staff type.
//
// Given a storefront request it opens filled in from it, and creating the
// booking marks the request Converted. Given a lead ("Build a booking for
// them") the first step is filled in and the booking hangs on that lead.
export function NewBookingModal({
  onClose,
  onCreated,
  onReview,
  request,
  lead,
}: {
  onClose: () => void;
  // said: one line saying exactly what was sent to the customer.
  onCreated: (bookingId: string, said?: string) => void | Promise<void>;
  // Called when the order needed review and became a request instead.
  onReview?: () => void;
  request?: DesignRequest;
  lead?: LeadPrefill;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(request || lead ? 2 : 1);

  // ---- step 1: who
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<CustomerMatch[]>([]);
  const [leadRows, setLeadRows] = useState<InboxRow[] | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(request?.customerId ?? null);
  const [accountName, setAccountName] = useState(request?.customerId ? request.customerName : "");
  const [leadId, setLeadId] = useState<string | null>(lead?.id ?? null);
  const [leadName, setLeadName] = useState(lead?.name ?? "");
  const [name, setName] = useState(request?.customerName ?? lead?.name ?? "");
  const [phone, setPhone] = useState(request?.phone ?? lead?.phone ?? "");
  const [email, setEmail] = useState(request?.email ?? lead?.email ?? "");

  // ---- step 2: what and when
  const [date, setDate] = useState(request ? request.eventDate.slice(0, 10) : (lead?.date ?? ""));
  const [time, setTime] = useState(request?.eventTime ?? "");
  const [mode, setMode] = useState<"items" | "package">(request?.cart.package ? "package" : "items");
  const [available, setAvailable] = useState<AvailableItem[] | null>(null);
  const [loadedFor, setLoadedFor] = useState("");
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [packages, setPackages] = useState<Package[]>([]);
  const [packageId, setPackageId] = useState<string | null>(request?.cart.package?.id ?? null);
  const [search, setSearch] = useState("");
  // itemId -> quantity, in the order added.
  const [cart, setCart] = useState<Record<string, number>>(() => Object.fromEntries(request ? request.cart.items.map((i) => [i.itemId, i.quantity]) : (lead?.itemIds ?? []).map((itemId) => [itemId, 1])));
  // itemId -> groupId -> addonId ("" means cleared)
  const [picks, setPicks] = useState<Record<string, Record<string, string>>>({});
  const requestAddonIds = useMemo(() => new Set((request?.cart.addons ?? []).flatMap((a) => (a.addonId ? [a.addonId] : []))), [request]);
  const [dropped, setDropped] = useState<string | null>(null);
  const [occasion, setOccasion] = useState(request?.occasion ?? "");
  const [guests, setGuests] = useState(request?.guestCount ? String(request.guestCount) : "");
  const [address, setAddress] = useState(request?.address ?? "");
  const [addressCheck, setAddressCheck] = useState<StaffAddressCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [setupNotes, setSetupNotes] = useState(request?.setupNotes ?? "");

  // ---- step 3: review and send
  const [priceText, setPriceText] = useState<string | null>(request && request.total !== null ? String(request.total) : null);
  const [preview, setPreview] = useState<StaffPreview | null>(null);
  const [balance, setBalance] = useState<BalancePreference>(request?.balancePaymentPreference ?? "Manual");
  const [agreedByPhone, setAgreedByPhone] = useState(false);
  const [noSend, setNoSend] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.matches("input, textarea, select"))) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Everything in the catalog (to say what is not free) and the packages.
  useEffect(() => {
    let live = true;
    Promise.all([getItems(), getPackages(), getInbox()])
      .then(([items, pkgs, inbox]) => {
        if (!live) return;
        setAllItems(items);
        setPackages(pkgs.filter((p) => p.status === "Published"));
        setLeadRows(inbox.rows.filter((r) => r.kind === "lead" && (r.bucket === "new" || r.bucket === "follow-up")));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // What can be booked on the chosen date. When the date changes, anything
  // already picked that is no longer free is taken out, with a line saying so.
  useEffect(() => {
    if (!date) return;
    let live = true;
    getAvailableItems(date)
      .then((items) => {
        if (!live) return;
        setAvailable(items);
        setLoadedFor(date);
        setCart((prev) => {
          const next: Record<string, number> = {};
          const lost: string[] = [];
          for (const [id, qty] of Object.entries(prev)) {
            const item = items.find((i) => i.id === id);
            if (!item) lost.push(id);
            else next[id] = Math.min(qty, item.freeUnits);
          }
          setDropped(lost.length > 0 ? `${lost.length} ${lost.length === 1 ? "item was" : "items were"} taken out: not free on ${longDay(date)}.` : null);
          return next;
        });
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load what is free that day"));
    return () => {
      live = false;
    };
  }, [date]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      searchCustomers(q)
        .then((rows) => live && setCustomers(rows))
        .catch(() => live && setCustomers([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const loadingItems = date !== "" && loadedFor !== date;
  const byId = useMemo(() => new Map((available ?? []).map((i) => [i.id, i])), [available]);
  const pickOf = (item: AvailableItem, groupId: string): string => {
    const override = picks[item.id]?.[groupId];
    if (override !== undefined) return override;
    const group = item.addonGroups.find((g) => g.id === groupId);
    return group?.addons.find((a) => requestAddonIds.has(a.id))?.id ?? "";
  };

  // ---- a package: free only when every item in it has enough free units
  const pkg = mode === "package" ? (packages.find((p) => p.id === packageId) ?? null) : null;
  const packageBlock = (p: Package): string | null => {
    if (!available) return null;
    const short = p.items.filter((row) => (byId.get(row.itemId)?.freeUnits ?? 0) < row.quantity).map((row) => row.item.name);
    return short.length > 0 ? `Not free that day: ${short.join(", ")}` : null;
  };
  const guestNumber = guests.trim() === "" ? null : Number(guests);
  const guestsOk = guestNumber === null || (Number.isInteger(guestNumber) && guestNumber >= 1 && guestNumber <= 5000);
  const packagePrice = (p: Package): number | null => {
    if (p.pricingMode !== "per_guest") return Number(p.price);
    if (guestNumber === null || !guestsOk) return null;
    return Math.round((Number(p.basePrice ?? 0) + Number(p.price) * guestNumber) * 100) / 100;
  };
  const guestRange = (p: Package) => (p.pricingMode === "per_guest" ? `${p.minGuests ?? 1} to ${p.maxGuests ?? 5000} guests` : null);

  const chosenIds = pkg ? pkg.items.map((row) => row.itemId) : Object.keys(cart);
  const chosenItems = chosenIds.map((id) => byId.get(id)).filter((i): i is AvailableItem => !!i);
  const qtyOf = (id: string) => (pkg ? (pkg.items.find((row) => row.itemId === id)?.quantity ?? 1) : (cart[id] ?? 1));

  const needle = search.trim().toLowerCase();
  const results = (available ?? []).filter((i) => !(i.id in cart) && (needle === "" || i.name.toLowerCase().includes(needle))).slice(0, MAX_LIST);
  // Items that match the search but cannot be booked that day: shown, blocked.
  const blocked = needle === "" || !available ? [] : allItems.filter((i) => !byId.has(i.id) && i.name.toLowerCase().includes(needle)).slice(0, 8);

  function setQty(id: string, qty: number, max: number) {
    setCart((prev) => ({ ...prev, [id]: Math.max(1, Math.min(max, qty)) }));
  }
  function remove(id: string) {
    setCart((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setPicks((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // The same arithmetic the server does: price times quantity, plus each
  // chosen option's change times the quantity; a package is its own price.
  const lines = chosenItems.map((item) => {
    const qty = qtyOf(item.id);
    const chosen = item.addonGroups.flatMap((group) => {
      const addon = group.addons.find((a) => a.id === pickOf(item, group.id));
      return addon ? [addon] : [];
    });
    const delta = chosen.reduce((sum, a) => sum + a.priceDelta, 0);
    return { item, qty, base: item.price === null ? null : item.price * qty, delta: delta * qty, options: chosen.map((a) => a.name) };
  });
  const addonsTotal = lines.reduce((sum, l) => sum + l.delta, 0);
  const priced = lines.filter((l) => l.base !== null);
  const computed = pkg ? (packagePrice(pkg) === null ? null : Math.round(((packagePrice(pkg) as number) + addonsTotal) * 100) / 100) : priced.length === 0 ? null : Math.round(priced.reduce((sum, l) => sum + (l.base ?? 0) + l.delta, 0) * 100) / 100;
  const shownPrice = priceText ?? (computed === null ? "" : String(computed));
  const priceNumber = shownPrice.trim() === "" ? null : Number(shownPrice);
  const priceOk = priceNumber === null || (Number.isFinite(priceNumber) && priceNumber >= 0);

  // The review step asks the server what this order will do.
  const previewKey = step === 3 && priceOk ? JSON.stringify([chosenIds, pkg?.id ?? null, priceNumber, occasion]) : null;
  useEffect(() => {
    if (!previewKey) return;
    let live = true;
    const [ids, pid, total, occ] = JSON.parse(previewKey) as [string[], string | null, number | null, string];
    const t = setTimeout(() => {
      previewStaffBooking({ itemIds: ids, ...(pid ? { packageId: pid } : {}), total, ...(occ ? { occasion: occ } : {}), converting: Boolean(request) })
        .then((p) => live && setPreview(p))
        .catch(() => live && setPreview(null));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [previewKey, request]);

  function chooseCustomer(c: CustomerMatch) {
    setCustomerId(c.id);
    setAccountName(c.name ?? c.email);
    setName(c.name ?? "");
    setPhone(c.phone);
    setEmail(c.email);
    setQuery("");
  }
  function chooseLead(r: InboxRow) {
    setLeadId(r.id);
    setLeadName(r.name);
    setName(r.name === "No name yet" ? "" : r.name);
    setPhone(r.phone ?? "");
    setEmail(r.email ?? "");
    if (r.eventDate && !date) setDate(r.eventDate);
    setQuery("");
  }
  function startOver() {
    setCustomerId(null);
    setLeadId(null);
    setName("");
    setPhone("");
    setEmail("");
  }

  async function checkAddress() {
    if (address.trim() === "") return;
    setChecking(true);
    try {
      const got = await checkStaffAddress(address.trim());
      setAddressCheck(got);
      if (got.exact && got.formattedAddress) setAddress(got.formattedAddress);
    } catch (err) {
      setAddressCheck({ exact: null, formattedAddress: null, reason: err instanceof Error ? err.message : "The lookup did not answer." });
    } finally {
      setChecking(false);
    }
  }

  const missingOptions = chosenItems.flatMap((item) => item.addonGroups.filter((g) => g.required && g.addons.length > 0 && !pickOf(item, g.id)).map((g) => `${item.name}: ${g.name}`));
  const whoProblem = name.trim() === "" ? "Type the customer's name." : phone.trim() === "" ? "Type a phone number." : email.trim() === "" ? "Type an email address." : null;
  const whatProblem = !date
    ? "Pick the event date."
    : loadingItems
      ? "Checking what is free that day."
      : mode === "package" && !pkg
        ? "Pick a package."
        : mode === "package" && pkg && packageBlock(pkg)
          ? `${pkg.name} cannot be booked on this date. ${packageBlock(pkg)}.`
          : mode === "package" && pkg?.pricingMode === "per_guest" && (guestNumber === null || !guestsOk)
            ? "Type the guest count. This package is priced per guest."
            : mode === "items" && chosenItems.length === 0
              ? "Add at least one item."
              : !guestsOk
                ? "The guest count must be a whole number from 1 to 5000."
                : missingOptions.length > 0
                  ? `Answer the required options: ${missingOptions.join(", ")}.`
                  : null;

  function goTo(next: 1 | 2 | 3) {
    setError(null);
    if (next > 1 && whoProblem) {
      setStep(1);
      return setError(whoProblem);
    }
    if (next > 2 && whatProblem) {
      setStep(2);
      return setError(whatProblem);
    }
    setStep(next);
  }

  async function create() {
    setError(null);
    if (whoProblem) return goTo(2);
    if (whatProblem) return goTo(3);
    if (!priceOk) return setError("The total must be a number of 0 or more.");
    setBusy(true);
    const asked = Boolean(request) || !noSend;
    try {
      const result = await createStaffBooking({
        ...(customerId ? { customerId } : {}),
        customerName: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        itemIds: chosenItems.map((i) => i.id),
        quantities: pkg ? {} : Object.fromEntries(chosenItems.map((i) => [i.id, cart[i.id]])),
        addons: Object.fromEntries(chosenItems.map((i) => [i.id, i.addonGroups.map((g) => pickOf(i, g.id)).filter((id) => id !== "")] as const).filter(([, ids]) => ids.length > 0)),
        ...(pkg ? { packageId: pkg.id } : {}),
        eventDate: date,
        ...(time.trim() ? { eventTime: time.trim() } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(setupNotes.trim() ? { setupNotes: setupNotes.trim() } : {}),
        ...(guestNumber !== null ? { guestCount: guestNumber } : {}),
        ...(priceNumber !== computed ? { total: priceNumber } : {}),
        ...(occasion ? { occasion } : {}),
        balancePaymentPreference: balance,
        ...(agreedByPhone ? { agreed: true } : {}),
        ...(request ? { designRequestId: request.id } : {}),
        ...(leadId ? { leadId } : {}),
        ...(!asked ? { sendPayLink: false } : {}),
      });
      if (result.reviewRequired) {
        // At or over the review amount: it became a request, nothing is held.
        setReviewMessage(`${result.reviewReason ? `${result.reviewReason}, so this` : "This one needs review, so it"} was sent to Leads, Storefront requests, instead of being held. Nothing is locked yet.`);
        setBusy(false);
        onReview?.();
        return;
      }
      await onCreated(result.bookingId, sentLine(result, asked));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the booking");
      setBusy(false);
    }
  }

  const title = request ? "Convert storefront request" : lead ? `Build a booking for ${lead.name || "this lead"}` : "New booking";
  const matchingLeads = query.trim().length < 2 ? [] : (leadRows ?? []).filter((r) => `${r.name} ${r.contactText ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6);
  const shownCustomers = query.trim().length < 2 ? [] : customers;
  const current = STEPS[step - 1];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal new-booking" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <ol className="step-list" aria-label="Steps">
          {STEPS.map((s) => (
            <li key={s.n}>
              <button type="button" className={step === s.n ? "step-button step-current" : "step-button"} aria-current={step === s.n ? "step" : undefined} onClick={() => goTo(s.n)} disabled={busy || reviewMessage !== null}>
                {s.n}. {s.title}
              </button>
            </li>
          ))}
        </ol>
        <p className="muted field-help" data-testid="step-help">
          {current.help}
        </p>

        <div className="add-item-form">
          {step === 1 && (
            <div className="modal-section" data-step="who">
              {leadId && (
                <p>
                  Building this booking for the lead <strong>{leadName || "with no name yet"}</strong>. It will hang on that lead, and the lead moves to Booked.{" "}
                  {!lead && (
                    <button type="button" className="btn-secondary" onClick={startOver}>
                      Use someone else
                    </button>
                  )}
                </p>
              )}
              {customerId && (
                <p>
                  Using the account of <strong>{accountName}</strong>. The booking will show in their My party.{" "}
                  {!request && (
                    <button type="button" className="btn-secondary" onClick={startOver}>
                      Use someone else
                    </button>
                  )}
                </p>
              )}
              {!customerId && !leadId && (
                <>
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads and customers by name, phone or email" aria-label="Search leads and customers" />
                  {query.trim().length >= 2 && (
                    <ul className="addon-list" aria-label="Matching leads and customers">
                      {matchingLeads.map((r) => (
                        <li key={`lead-${r.id}`} className="unit-row">
                          <span>
                            <strong>{r.name}</strong> <span className="muted">· Lead, {r.source} · {r.contactText ?? "no contact details"}</span>
                          </span>
                          <button type="button" className="btn-secondary" onClick={() => chooseLead(r)}>
                            Use this lead
                          </button>
                        </li>
                      ))}
                      {shownCustomers.map((c) => (
                        <li key={`customer-${c.id}`} className="unit-row">
                          <span>
                            <strong>{c.name ?? "No name"}</strong> <span className="muted">· Customer account · {c.phone} · {c.email}</span>
                          </span>
                          <button type="button" className="btn-secondary" onClick={() => chooseCustomer(c)}>
                            Use this customer
                          </button>
                        </li>
                      ))}
                      {matchingLeads.length === 0 && shownCustomers.length === 0 && <li className="muted">No match. Fill in the details below to add them as someone new.</li>}
                    </ul>
                  )}
                </>
              )}
              <div className="field-row">
                <label>
                  Name*
                  <input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label>
                  Phone*
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" />
                </label>
                <label>
                  Email*
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </label>
              </div>
              <span className="muted field-help">{customerId ? "These are the account's details. Change them here only for this booking." : "The phone and email are where the contract or pay link is sent. No store account is created; a new person gets a lead."}</span>
            </div>
          )}

          {step === 2 && (
            <div className="modal-section" data-step="what">
              <div className="field-row">
                <label>
                  Event date*
                  <input type="date" min={todayEastern()} value={date} onChange={(e) => setDate(e.target.value)} required />
                </label>
                <label>
                  Time
                  <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="e.g. 2 PM to 6 PM" maxLength={60} />
                </label>
              </div>
              {!date && <p className="muted">Pick the date first. What is free that day shows next.</p>}
              {date && (
                <>
                  <div className="filter-row" role="group" aria-label="What they are booking">
                    <button type="button" aria-pressed={mode === "items"} className={mode === "items" ? "btn-primary" : "btn-secondary"} onClick={() => setMode("items")} disabled={Boolean(request)}>
                      Items and services
                    </button>
                    <button type="button" aria-pressed={mode === "package"} className={mode === "package" ? "btn-primary" : "btn-secondary"} onClick={() => setMode("package")} disabled={Boolean(request)}>
                      A package
                    </button>
                  </div>
                  <span className="muted field-help">{mode === "items" ? "Pick single items and services. Anything not free that day is shown but cannot be added." : "A package is booked as it is, at its own price. One that has an item not free that day cannot be picked."}</span>
                  {loadingItems && <p className="muted">Checking what is free on {longDay(date)}…</p>}
                  {dropped && <p className="form-error">{dropped}</p>}

                  {mode === "items" && available && !loadingItems && (
                    <>
                      <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items and services" aria-label="Search items" />
                      <ul className="addon-list new-booking-results" aria-label="Items for this date">
                        {results.map((item) => (
                          <li key={item.id} className="unit-row">
                            <span>
                              <strong>{item.name}</strong>{" "}
                              <span className="muted">
                                · {item.price === null ? "TBD" : usd(item.price)}
                                {item.priceUnit ? ` ${item.priceUnit}` : ""} · {item.freeUnits} free
                              </span>
                            </span>
                            <button type="button" className="btn-secondary" onClick={() => setCart((prev) => ({ ...prev, [item.id]: 1 }))}>
                              Add
                            </button>
                          </li>
                        ))}
                        {blocked.map((item) => (
                          <li key={item.id} className="unit-row unit-row-blocked">
                            <span>
                              <strong>{item.name}</strong> <span className="muted">· not free on this date</span>
                            </span>
                            <button type="button" className="btn-secondary" disabled aria-label={`${item.name} is not free on this date`}>
                              Not free
                            </button>
                          </li>
                        ))}
                        {results.length === 0 && blocked.length === 0 && <li className="muted">Nothing matches.</li>}
                      </ul>
                    </>
                  )}

                  {mode === "package" && available && !loadingItems && (
                    <ul className="addon-list new-booking-results" aria-label="Packages for this date">
                      {packages.map((p) => {
                        const why = packageBlock(p);
                        return (
                          <li key={p.id} className={why ? "unit-row unit-row-blocked" : "unit-row"}>
                            <span>
                              <strong>{p.name}</strong>{" "}
                              <span className="muted">
                                · {p.pricingMode === "per_guest" ? `${usd(Number(p.basePrice ?? 0))} plus ${usd(Number(p.price))} per guest, ${guestRange(p)}` : usd(Number(p.price))} · {p.items.map((row) => (row.quantity > 1 ? `${row.item.name} x ${row.quantity}` : row.item.name)).join(", ")}
                                {why ? ` · ${why}` : ""}
                              </span>
                            </span>
                            <button type="button" className={packageId === p.id ? "btn-primary" : "btn-secondary"} disabled={Boolean(why) || Boolean(request)} aria-pressed={packageId === p.id} onClick={() => setPackageId(p.id)}>
                              {why ? "Not free" : packageId === p.id ? "Picked" : "Pick"}
                            </button>
                          </li>
                        );
                      })}
                      {packages.length === 0 && <li className="muted">There are no published packages.</li>}
                    </ul>
                  )}

                  {lines.length > 0 && (
                    <div className="new-booking-cart" aria-label="On this booking">
                      {lines.map(({ item, qty }) => (
                        <div key={item.id} className="addon-group">
                          <div className="addon-group-head">
                            <strong>{item.name}</strong>
                            {pkg ? (
                              <span className="muted">{qty > 1 ? `x ${qty}, ` : ""}in the package</span>
                            ) : (
                              <>
                                <label className="checkbox-label">
                                  Qty
                                  <input type="number" min={1} max={item.freeUnits} value={qty} aria-label={`Quantity of ${item.name}`} onChange={(e) => setQty(item.id, Number(e.target.value) || 1, item.freeUnits)} />
                                  <span className="muted">of {item.freeUnits} free</span>
                                </label>
                                <button type="button" className="icon-btn" aria-label={`Remove ${item.name}`} onClick={() => remove(item.id)}>
                                  <X size={13} />
                                </button>
                              </>
                            )}
                          </div>
                          {item.addonGroups
                            .filter((g) => g.addons.length > 0)
                            .map((group) => (
                              <label key={group.id}>
                                {group.name}
                                {group.required ? "*" : ""}
                                <select value={pickOf(item, group.id)} aria-label={`${group.name} for ${item.name}`} onChange={(e) => setPicks((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] ?? {}), [group.id]: e.target.value } }))}>
                                  <option value="">{group.required ? "Choose one" : "None"}</option>
                                  {group.addons.map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.name}
                                      {deltaLabel(a.priceDelta) ? ` (${deltaLabel(a.priceDelta)})` : ""}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="field-row">
                <label>
                  Occasion
                  <select value={occasion} onChange={(e) => setOccasion(e.target.value)} aria-label="Occasion">
                    <option value="">Not said</option>
                    {OCCASION_GROUPS.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        <option value={group.label}>{group.label} (general)</option>
                        {group.occasions.map((o) => (
                          <option key={`${group.label}-${o}`} value={o}>
                            {o}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label>
                  Guest count{pkg?.pricingMode === "per_guest" ? "*" : ""}
                  <input type="number" min={1} max={5000} value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="How many guests" aria-label="Guest count" />
                </label>
              </div>
              <label>
                Event address
                <span className="address-lookup">
                  <input
                    value={address}
                    onChange={(e) => {
                      setAddress(e.target.value);
                      setAddressCheck(null);
                    }}
                    placeholder="Street number, street, town, state"
                    maxLength={300}
                    aria-label="Event address"
                  />
                  <button type="button" className="btn-secondary" disabled={checking || address.trim() === ""} onClick={() => void checkAddress()}>
                    {checking ? "Looking it up…" : "Look up address"}
                  </button>
                </span>
              </label>
              {addressCheck && (
                <span className={addressCheck.exact ? "muted field-help" : "form-error"} role="status" data-testid="address-check">
                  {addressCheck.exact ? "Found. This is the exact address as Google writes it." : addressCheck.exact === false ? `Not an exact street address: ${addressCheck.reason ?? "check the number and street"}. You can still book it; fix the address on the booking later.` : `The lookup is not available right now${addressCheck.reason ? ` (${addressCheck.reason})` : ""}. The address is saved as typed and checked again after booking.`}
                </span>
              )}
              {!addressCheck && <span className="muted field-help">Look up address checks it is a real street address, so the crew and the calendar get a map link. You can book without one and add it later.</span>}
              <label>
                Setup notes
                <textarea rows={2} value={setupNotes} onChange={(e) => setSetupNotes(e.target.value)} maxLength={500} placeholder="Backyard, gate on the left, power on the patio" aria-label="Setup notes" />
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="modal-section" data-step="review">
              <p>
                <strong>{name}</strong> · {longDay(date)}
                {time.trim() ? `, ${time.trim()}` : ""}
                {occasion ? ` · ${occasion}` : ""}
                {guestNumber !== null ? ` · ${guestNumber} guests` : ""}
                <br />
                <span className="muted">
                  {phone} · {email}
                  {address.trim() ? ` · ${address.trim()}` : " · no address yet"}
                </span>
              </p>
              <ul className="addon-list">
                {pkg && (
                  <li className="unit-row">
                    <span>
                      <strong>{pkg.name}</strong> (package)
                    </span>
                    <span>{packagePrice(pkg) === null ? "TBD" : usd(packagePrice(pkg) as number)}</span>
                  </li>
                )}
                {lines.map(({ item, qty, base, delta, options }) => (
                  <li key={item.id} className="unit-row">
                    <span>
                      {item.name}
                      {qty > 1 ? ` x ${qty}` : ""}
                      {options.length > 0 ? <span className="muted"> · {options.join(", ")}</span> : null}
                    </span>
                    <span>{pkg ? (delta > 0 ? `+ ${usd(delta)}` : "in the package") : base === null ? "TBD" : usd(base + delta)}</span>
                  </li>
                ))}
              </ul>
              <label>
                Total
                <input type="number" step="0.01" min={0} value={shownPrice} onChange={(e) => setPriceText(e.target.value)} placeholder={computed === null ? "No price set on these items" : undefined} aria-label="Total" />
                <span className="muted field-help">{computed === null ? "Nothing here has a price, so there is no worked out total." : `Worked out at ${usd(computed)}.`} Change it only to quote a different price.</span>
              </label>

              {preview && (
                <div className="review-facts" data-testid="review-facts">
                  <p>
                    <span className="detail-field-label">Total</span>
                    <strong>{preview.total === null ? "No price yet" : usd(preview.total)}</strong>
                  </p>
                  <p>
                    <span className="detail-field-label">{preview.collectsFull ? "Due now (paid in full)" : `Retainer (${preview.retainerPercent}%)`}</span>
                    <strong>{preview.retainer === null ? "Worked out once there is a price" : usd(preview.retainer)}</strong>
                  </p>
                  <p>
                    <span className="detail-field-label">Policy or contract</span>
                    {preview.why}
                  </p>
                  <p>
                    <span className="detail-field-label">Review</span>
                    {request
                      ? "This request has already been reviewed, so the booking is made now."
                      : preview.review.required
                        ? `${preview.review.sentence ?? "This order is at or over the review amount"}. It will not be held: it goes to Leads, Storefront requests, for a person to look at first (Settings, Booking rules, Review rules).`
                        : "Under the review amount for its occasion, so the date and items are held as soon as you create it."}
                  </p>
                  <p>
                    <span className="detail-field-label">What the customer is sent</span>
                    {!request && preview.review.required
                      ? "Nothing yet. Nothing is held until the request is converted."
                      : !request && noSend
                        ? "Nothing. Use Send pay link on the booking when you are ready."
                        : preview.path === "contract"
                          ? `A text and an email with the contract link, saying the retainer is ${preview.retainer === null ? "due on signing" : usd(preview.retainer)}. The pay link follows as soon as they sign.`
                          : `A text and an email with the pay link for ${preview.retainer === null ? "the retainer" : usd(preview.retainer)}. ${preview.payLinksOpenStorefront ? "They read and accept the rental policy on the pay page, then pay." : "The link opens the payment page."} Reminders follow if it stays unpaid.`}
                  </p>
                </div>
              )}
              {!preview && <p className="muted">Working out the retainer and the path…</p>}

              {!request && (
                <label className="checkbox-label">
                  <input type="checkbox" checked={noSend} onChange={(e) => setNoSend(e.target.checked)} aria-label="Create without sending" />
                  Create without sending anything to the customer
                </label>
              )}
              {preview?.path === "policy" && !(preview.review.required && !request) && (
                <>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={agreedByPhone} onChange={(e) => setAgreedByPhone(e.target.checked)} aria-label="Customer agreed by phone" />
                    I read the rental policy to the customer and they agreed
                  </label>
                  <span className="muted field-help">
                    Optional. It is kept as "Staff confirmed by phone".{" "}
                    {preview.payLinksOpenStorefront
                      ? 'The customer still accepts the policy themselves on the pay page, and the booking then reads "Policy accepted by customer".'
                      : 'The store\'s pay page is not switched on yet (Settings, Integrations), so the customer is not shown the policy when they pay. Without this tick the booking stays under Needs action as "Policy not accepted".'}
                  </span>
                </>
              )}
              <details className="lead-more">
                <summary>More: how the balance will be collected</summary>
                <label>
                  How the balance will be collected
                  <select value={balance} onChange={(e) => setBalance(e.target.value as BalancePreference)} aria-label="Balance payment preference">
                    {BALANCE_PREFERENCES.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="muted field-help">A note for your team only. Nothing is charged or sent because of it.</span>
              </details>
            </div>
          )}

          {reviewMessage && (
            <p className="bulk-result" role="status">
              {reviewMessage}{" "}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  onClose();
                  navigate("leads", { leadView: "requests" });
                }}
              >
                Open storefront requests
              </button>
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            {step < 3 && (
              <button type="button" className="btn-primary" onClick={() => goTo((step + 1) as 2 | 3)} disabled={busy}>
                Next: {step === 1 ? STEPS[1].title : STEPS[2].title}
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn-primary" onClick={() => void create()} disabled={busy || reviewMessage !== null || !priceOk}>
                {busy ? "Creating…" : !request && preview?.review.required ? "Send to review" : !request && noSend ? "Create without sending" : "Create and send to customer"}
              </button>
            )}
            {step > 1 && (
              <button type="button" className="btn-secondary" onClick={() => goTo((step - 1) as 1 | 2)} disabled={busy || reviewMessage !== null}>
                Back
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
