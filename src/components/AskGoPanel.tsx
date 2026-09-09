import { type FormEvent, useState } from "react";
import { X } from "lucide-react";
import { recommend } from "../lib/api";
import type { RecommendResponse } from "../lib/types";

const EXAMPLE = "Bluey birthday, 20 kids, $2000 budget";

export function AskGoPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [theme, setTheme] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecommendResponse | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!theme.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await recommend(theme));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recommendation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {open && <div className="panel-backdrop" onClick={onClose} />}
      <aside className={open ? "askgo-panel askgo-panel-open" : "askgo-panel"} aria-hidden={!open}>
        <div className="askgo-panel-head">
          <h2>Ask GO</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Ask GO">
            <X size={16} />
          </button>
        </div>
        <p className="muted askgo-intro">Describe the party. Get real items and a real price back, pulled straight from the catalog.</p>

        <form onSubmit={handleSubmit} className="askgo-form">
          <input
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder={EXAMPLE}
            aria-label="Theme or occasion"
          />
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "Thinking…" : "Build it"}
          </button>
        </form>

        {error && <p className="form-error">{error}</p>}

        {result && (
          <div className="askgo-result">
            {result.rationale && <p className="rationale">{result.rationale}</p>}
            {result.note && <p className="muted">{result.note}</p>}
            {result.items.length === 0 ? (
              <p className="muted">Nothing matched. Try a broader theme or check the catalog has priced items.</p>
            ) : (
              <>
                <ul className="item-list">
                  {result.items.map((item) => (
                    <li key={item.id} className="item-row">
                      <span className="item-name">
                        {item.name}
                        <span className="item-category"> · {item.category}</span>
                      </span>
                      <span className="item-price">
                        {Number(item.price).toLocaleString("en-US", { style: "currency", currency: "USD" })}
                        {item.priceUnit ? ` · ${item.priceUnit}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="total-row">
                  <span>Total</span>
                  <span>{result.total.toLocaleString("en-US", { style: "currency", currency: "USD" })}</span>
                </div>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
