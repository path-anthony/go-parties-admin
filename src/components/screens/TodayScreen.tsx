import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate as useRouterNavigate } from "react-router-dom";
import { getToday } from "../../lib/api";
import type { TodayItem, TodayView } from "../../lib/types";
import { LeadPopup, type PopupTarget } from "../LeadPopup";

// Block F3a. Today replaces Overview: what needs doing, in three columns of
// work. Every item is one line with one button. A lead, a storefront request
// or a cancellation request opens its popup here; a booking opens in Bookings.

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const paidWhen = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const longDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

export function TodayScreen() {
  const go = useRouterNavigate();
  const [data, setData] = useState<TodayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<PopupTarget | null>(null);

  const load = useCallback(() => getToday().then(setData), []);
  useEffect(() => {
    let live = true;
    getToday()
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't load today's work"));
    return () => {
      live = false;
    };
  }, []);

  const open = (item: TodayItem) => {
    if (item.open.kind === "booking") go(`/bookings?booking=${item.open.id}`);
    else setTarget({ kind: item.open.kind, id: item.open.id });
  };

  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Today</h2>
        <p className="muted">{data ? `${longDay(data.today)}. ` : ""}What needs action, who to contact and what to do next. Work the columns left to right. Each line has one button that opens it.</p>
      </div>
      {error && <p className="form-error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <section className="today-summary" aria-label="Summary">
            <div className="today-count today-money" data-testid="money-in">
              <span className="kpi-section-label">Money in, last {data.moneyIn.days} days</span>
              <strong>{money(data.moneyIn.totalCents)}</strong>
              <span className="muted">
                {data.moneyIn.payments.length} {data.moneyIn.payments.length === 1 ? "payment" : "payments"}
              </span>
            </div>
            {data.columns.map((c) => (
              <div key={c.key} className="today-count" data-count={c.key}>
                <span className="kpi-section-label">{c.label}</span>
                <strong>{c.count}</strong>
                <span className="muted">{c.count === 0 ? "Nothing waiting" : c.count === 1 ? "thing to do" : "things to do"}</span>
              </div>
            ))}
          </section>
          {data.moneyIn.payments.length > 0 && (
            <details className="today-payments">
              <summary>See the payments</summary>
              <ul className="addon-list">
                {data.moneyIn.payments.map((p) => (
                  <li key={p.id}>
                    <Link to={`/bookings?booking=${p.bookingId}`}>
                      {paidWhen(p.paidAt)} · {p.customerName} · {money(p.amountCents)} {p.kind} · {p.method === "card" ? "card" : `${p.method}, recorded by staff`}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="today-columns">
            {data.columns.map((c) => (
              <section key={c.key} className="today-column" aria-label={c.label} data-column={c.key}>
                <h3>
                  {c.label} <span className="today-column-count">{c.count}</span>
                </h3>
                <p className="muted field-help">{c.help}</p>
                {c.count === 0 && <p className="today-empty">{c.empty}</p>}
                {c.groups
                  .filter((g) => g.items.length > 0)
                  .map((g) => (
                    <div key={g.key} className="today-group" data-group={g.key}>
                      <span className="detail-field-label">
                        {g.label} ({g.items.length})
                      </span>
                      <ul>
                        {g.items.map((item) => (
                          <li key={item.key} className="today-item">
                            <span className="today-item-text">
                              <strong>{item.title}</strong>
                              <span className="muted">{item.detail}</span>
                            </span>
                            <button type="button" className="btn-secondary" onClick={() => open(item)}>
                              {item.button}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </section>
            ))}
          </div>
        </>
      )}
      {target && <LeadPopup target={target} onClose={() => setTarget(null)} onChanged={() => void load()} />}
    </div>
  );
}
