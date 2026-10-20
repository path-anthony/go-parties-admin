import { type FormEvent, useEffect, useState } from "react";
import { setPasswordWithToken, tokenInfo } from "../lib/api";

// The page an invite or reset link opens: /set-password?token=... It asks
// the server who the link is for, takes the new password, and sends the
// person into the admin (or to the code step when two-step is on).
export function SetPasswordScreen({ onDone }: { onDone: () => void }) {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [info, setInfo] = useState<{ kind: "invite" | "reset"; name: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    tokenInfo(token)
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : "That link is not valid."));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) return setError("The two passwords don't match.");
    setError(null);
    setLoading(true);
    try {
      await setPasswordWithToken(token, password);
      // Signed in now (or on the code step): back to the app's own address.
      window.history.replaceState(null, "", "/overview");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set the password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <form onSubmit={handleSubmit} className="login-card">
        <div className="wordmark">
          <span className="wordmark-go">GO!</span> EVENT GROUP
        </div>
        {!info && !error && <p className="muted">Checking the link…</p>}
        {info && (
          <>
            <p>
              {info.kind === "invite" ? "Welcome" : "Hi"}, {info.name}. {info.kind === "invite" ? "Set a password for" : "Choose a new password for"} <strong>{info.email}</strong>.
            </p>
            <label>
              New password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} autoFocus required />
              <span className="muted field-help">At least 10 characters.</span>
            </label>
            <label>
              Again
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
            </label>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        {info && (
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "Saving…" : "Set password and sign in"}
          </button>
        )}
        {error && !info && (
          <a className="btn-link login-link" href="/">
            Back to sign in
          </a>
        )}
      </form>
    </div>
  );
}
