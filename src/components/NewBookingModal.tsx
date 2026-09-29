import { type FormEvent, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { createStaffBooking, getAvailableItems, searchCustomers } from "../lib/api";
import { deltaLabel } from "../lib/addons";
import type { AvailableItem, CustomerMatch } from "../lib/types";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const todayEastern = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const MAX_LIST = 30;

// A booking taken for a customer by phone or in person. It sends the same
// request the storefront does, plus a quantity per item and an optional
// price, to the same booking code: what is offered for a date is the
// storefront's own list for that date, and the server takes the same unit
// and crew locks when it is created. New bookings start Held, and RUSH is
// worked out by the same rule as any other.
export function NewBookingModal({ onClose, onCreated }: { onClose: () => void; onCreated: (bookingId: string) => void | Promise<void> }) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [address, setAddress] = useState("");

  const [available, setAvailable] = useState<AvailableItem[] | null>(null);
  // The date the list on screen was loaded for; loading is when it differs.
  const [loadedFor, setLoadedFor] = useState("");
  const [search, setSearch] = useState("");
  // itemId -> quantity, in the order added.
  const [cart, setCart] = useState<Record<string, number>>({});
  // itemId -> groupId -> addonId
  const [picks, setPicks] = useState<Record<string, Record<string, string>>>({});
  const [dropped, setDropped] = useState<string | null>(null);

  const [customerQuery, setCustomerQuery] = useState("");
  const [matches, setMatches] = useState<CustomerMatch[]>([]);
  const [customerId, setCustomerId] = useState<string | null>(null);
  // The account's own name, for the line saying which account is in use.
  const [accountName, setAccountName] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const [priceText, setPriceText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !(e.target instanceof HTMLElement && e.target.matches("input, textarea, select"))) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // What can be booked on the chosen date. When the date changes, anything
  // already in the cart that is no longer free is dropped, and the counts
  // are clamped, with a line saying so.
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
          setDropped(lost.length > 0 ? `${lost.length} ${lost.length === 1 ? "item was" : "items were"} taken out of the list: not free on ${date}.` : null);
          return next;
        });
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load what is free that day"));
    return () => {
      live = false;
    };
  }, [date]);

  useEffect(() => {
    const q = customerQuery.trim();
    if (q.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      searchCustomers(q)
        .then((rows) => live && setMatches(rows))
        .catch(() => live && setMatches([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [customerQuery]);

  const loadingItems = date !== "" && loadedFor !== date;
  const shownMatches = customerQuery.trim().length < 2 ? [] : matches;
  const byId = useMemo(() => new Map((available ?? []).map((i) => [i.id, i])), [available]);
  const cartItems = Object.keys(cart)
    .map((id) => byId.get(id))
    .filter((i): i is AvailableItem => !!i);

  const query = search.trim().toLowerCase();
  const results = (available ?? []).filter((i) => !(i.id in cart) && (query === "" || i.name.toLowerCase().includes(query))).slice(0, MAX_LIST);

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
  // chosen option's change times the quantity.
  const lines = cartItems.map((item) => {
    const qty = cart[item.id];
    const chosen = Object.entries(picks[item.id] ?? {}).flatMap(([groupId, addonId]) => {
      const addon = item.addonGroups.find((g) => g.id === groupId)?.addons.find((a) => a.id === addonId);
      return addon ? [addon] : [];
    });
    const delta = chosen.reduce((sum, a) => sum + a.priceDelta, 0);
    return { item, qty, base: item.price === null ? null : item.price * qty, delta: delta * qty };
  });
  const priced = lines.filter((l) => l.base !== null);
  const computed = priced.length === 0 ? null : Math.round(priced.reduce((sum, l) => sum + (l.base ?? 0) + l.delta, 0) * 100) / 100;
  const shownPrice = priceText ?? (computed === null ? "" : String(computed));

  function chooseCustomer(c: CustomerMatch) {
    setCustomerId(c.id);
    setAccountName(c.name ?? c.email);
    setName(c.name ?? "");
    setPhone(c.phone);
    setEmail(c.email);
    setCustomerQuery("");
    setMatches([]);
  }
  function clearCustomer() {
    setCustomerId(null);
    setName("");
    setPhone("");
    setEmail("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (cartItems.length === 0) return setError("Add at least one item.");
    const missing = cartItems.flatMap((item) =>
      item.addonGroups.filter((g) => g.required && g.addons.length > 0 && !picks[item.id]?.[g.id]).map((g) => `${item.name}: ${g.name}`),
    );
    if (missing.length > 0) return setError(`Answer the required options first: ${missing.join(", ")}.`);
    const priceNumber = shownPrice.trim() === "" ? null : Number(shownPrice);
    if (priceNumber !== null && (!Number.isFinite(priceNumber) || priceNumber < 0)) return setError("The price must be a number of 0 or more.");

    setBusy(true);
    try {
      const result = await createStaffBooking({
        ...(customerId ? { customerId } : {}),
        customerName: name,
        phone,
        email,
        itemIds: cartItems.map((i) => i.id),
        quantities: Object.fromEntries(cartItems.map((i) => [i.id, cart[i.id]])),
        addons: Object.fromEntries(cartItems.map((i) => [i.id, Object.values(picks[i.id] ?? {})]).filter(([, v]) => (v as string[]).length > 0)),
        eventDate: date,
        ...(time.trim() ? { eventTime: time.trim() } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(priceNumber !== computed ? { total: priceNumber } : {}),
      });
      await onCreated(result.bookingId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the booking");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New booking" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>New booking</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="muted">
          For a customer booking by phone or in person. It starts as Held, holds the same units and crew a storefront booking would,
          and is tagged RUSH if it falls inside the minimum notice.
        </p>

        <form onSubmit={handleSubmit} className="add-item-form">
          <div className="modal-section">
            <span className="detail-field-label">1. Date</span>
            <div className="field-row">
              <label>
                Event date*
                <input type="date" min={todayEastern()} value={date} onChange={(e) => setDate(e.target.value)} required />
              </label>
              <label>
                Time
                <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="e.g. 2 PM" maxLength={60} />
              </label>
            </div>
            <label>
              Address
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Where the party is" maxLength={300} />
            </label>
          </div>

          <div className="modal-section">
            <span className="detail-field-label">2. Items</span>
            {!date && <p className="muted">Pick a date first. Only what is free that day is offered.</p>}
            {date && (
              <>
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items free on this date" aria-label="Search items" />
                {loadingItems && <p className="muted">Checking what is free on {date}…</p>}
                {dropped && <p className="form-error">{dropped}</p>}
                {available && !loadingItems && (
                  <ul className="addon-list new-booking-results" aria-label="Items free on this date">
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
                    {results.length === 0 && <li className="muted">Nothing free matches.</li>}
                  </ul>
                )}
              </>
            )}

            {lines.length > 0 && (
              <div className="new-booking-cart" aria-label="Items on this booking">
                {lines.map(({ item, qty }) => (
                  <div key={item.id} className="addon-group">
                    <div className="addon-group-head">
                      <strong>{item.name}</strong>
                      <label className="checkbox-label">
                        Qty
                        <input
                          type="number"
                          min={1}
                          max={item.freeUnits}
                          value={qty}
                          aria-label={`Quantity of ${item.name}`}
                          onChange={(e) => setQty(item.id, Number(e.target.value) || 1, item.freeUnits)}
                        />
                        <span className="muted">of {item.freeUnits} free</span>
                      </label>
                      <button type="button" className="icon-btn" aria-label={`Remove ${item.name}`} onClick={() => remove(item.id)}>
                        <X size={13} />
                      </button>
                    </div>
                    {item.addonGroups
                      .filter((g) => g.addons.length > 0)
                      .map((group) => (
                        <label key={group.id}>
                          {group.name}
                          {group.required ? "*" : ""}
                          <select
                            value={picks[item.id]?.[group.id] ?? ""}
                            aria-label={`${group.name} for ${item.name}`}
                            onChange={(e) =>
                              setPicks((prev) => {
                                const forItem = { ...(prev[item.id] ?? {}) };
                                if (e.target.value === "") delete forItem[group.id];
                                else forItem[group.id] = e.target.value;
                                return { ...prev, [item.id]: forItem };
                              })
                            }
                          >
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
          </div>

          <div className="modal-section">
            <span className="detail-field-label">3. Customer</span>
            {customerId ? (
              <p>
                Using the account of <strong>{accountName}</strong>.{" "}
                <button type="button" className="btn-secondary" onClick={clearCustomer}>
                  Use someone else
                </button>
              </p>
            ) : (
              <>
                <input
                  type="search"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Find an existing customer by name, phone or email"
                  aria-label="Search customers"
                />
                {customerQuery.trim().length >= 2 && (
                  <ul className="addon-list" aria-label="Matching customers">
                    {shownMatches.map((c) => (
                      <li key={c.id} className="unit-row">
                        <span>
                          <strong>{c.name ?? "No name"}</strong> <span className="muted">· {c.phone} · {c.email}</span>
                        </span>
                        <button type="button" className="btn-secondary" onClick={() => chooseCustomer(c)}>
                          Use
                        </button>
                      </li>
                    ))}
                    {shownMatches.length === 0 && <li className="muted">No match. Fill in the details below to add them as a new customer.</li>}
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
                <input value={phone} onChange={(e) => setPhone(e.target.value)} required />
              </label>
              <label>
                Email*
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
            </div>
            {!customerId && <span className="muted field-help">No account is created. The booking keeps these details.</span>}
          </div>

          <div className="modal-section">
            <span className="detail-field-label">4. Price</span>
            {lines.length === 0 ? (
              <p className="muted">Add items to see the price.</p>
            ) : (
              <>
                <ul className="addon-list">
                  {lines.map(({ item, qty, base, delta }) => (
                    <li key={item.id} className="unit-row">
                      <span>
                        {item.name}
                        {qty > 1 ? ` × ${qty}` : ""}
                      </span>
                      <span>{base === null ? "TBD" : usd(base + delta)}</span>
                    </li>
                  ))}
                </ul>
                <label>
                  Quoted total
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    value={shownPrice}
                    onChange={(e) => setPriceText(e.target.value)}
                    placeholder={computed === null ? "No price set on these items" : undefined}
                    aria-label="Quoted total"
                  />
                  <span className="muted field-help">
                    {computed === null ? "Nothing here has a price, so there is no computed total." : `Computed ${usd(computed)}.`} Change it to
                    quote something else.
                  </span>
                </label>
              </>
            )}
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create booking"}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
