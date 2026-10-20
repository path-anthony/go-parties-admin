import { type FormEvent, useState } from "react";
import { forgotPassword, login, loginTwoStep } from "../lib/api";
import type { AdminUser } from "../lib/types";

type Step = "password" | "code" | "forgot";

// Email and password; then the authenticator code when the person has
// two-step sign-in on. "Forgot your password" sends the reset email and
// always says the same thing, whether or not the address is known.
export function LoginScreen({ onSuccess }: { onSuccess: (user?: AdminUser) => void }) {
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      if (step === "password") {
        const r = await login(email, password);
        if (r.twoStep) {
          setPassword("");
          setStep("code");
        } else onSuccess(r.user);
      } else if (step === "code") {
        const r = await loginTwoStep(code);
        onSuccess(r.user);
      } else {
        const r = await forgotPassword(email);
        setNotice(r.message);
        setStep("password");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
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
        {step !== "code" && (
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
          </label>
        )}
        {step === "password" && (
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
        )}
        {step === "code" && (
          <label>
            Code from your authenticator app
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
            <span className="muted field-help">A backup code works here too.</span>
          </label>
        )}
        {step === "forgot" && <p className="muted">We'll email a link to set a new password.</p>}
        {error && <p className="form-error">{error}</p>}
        {notice && <p className="bulk-result" role="status">{notice}</p>}
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? "Checking…" : step === "password" ? "Enter" : step === "code" ? "Continue" : "Send reset link"}
        </button>
        {step === "password" && (
          <button type="button" className="btn-link login-link" onClick={() => { setError(null); setStep("forgot"); }}>
            Forgot your password?
          </button>
        )}
        {step !== "password" && (
          <button type="button" className="btn-link login-link" onClick={() => { setError(null); setCode(""); setStep("password"); }}>
            Back to sign in
          </button>
        )}
      </form>
    </div>
  );
}
