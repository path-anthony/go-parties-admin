import { type FormEvent, useState } from "react";
import { X } from "lucide-react";
import { recommend } from "../lib/api";
import type { AskGoMessage, Item } from "../lib/types";

const EXAMPLE = "Bluey birthday, 20 kids, $2000 budget";

type Result = { message: string; items: Item[]; total: number };

export function AskGoPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AskGoMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;
    const nextMessages: AskGoMessage[] = [...messages, { role: "user", content: input.trim() }];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const response = await recommend(nextMessages);
      setMessages([...nextMessages, { role: "assistant", content: response.message }]);
      if (response.ready) {
        setResult({ message: response.message, items: response.items, total: response.total });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recommendation failed");
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setMessages([]);
    setInput("");
    setResult(null);
    setError(null);
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

        {messages.length > 0 && (
          <ul className="askgo-thread">
            {messages.map((m, i) => (
              <li key={i} className={m.role === "user" ? "askgo-msg askgo-msg-user" : "askgo-msg askgo-msg-assistant"}>
                {m.content}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="form-error">{error}</p>}

        {!result && (
          <form onSubmit={handleSubmit} className="askgo-form">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={messages.length === 0 ? EXAMPLE : "Reply…"}
              aria-label="Message to Ask GO"
            />
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? "Thinking…" : messages.length === 0 ? "Build it" : "Send"}
            </button>
          </form>
        )}

        {result && (
          <div className="askgo-result">
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
            <button type="button" className="btn-secondary" onClick={handleReset}>
              Start over
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
