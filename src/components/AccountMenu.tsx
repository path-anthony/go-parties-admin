import { type FormEvent, useEffect, useRef, useState } from "react";
import { KeyRound, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { AUTH_EXPIRED_EVENT, changePassword, logout, twoStepConfirm, twoStepDisable, twoStepSetup } from "../lib/api";
import { useMe } from "../lib/me";

type Dialog = "password" | "two-step" | null;

// Top right: who is signed in, change password, two-step sign-in, log out.
export function AccountMenu() {
  const { me, refresh } = useMe();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="account-menu" ref={ref}>
      <button type="button" className="btn-secondary admin-logout" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <UserRound size={13} /> <span className="admin-logout-text">{me?.name ?? "Account"}</span>
      </button>
      {open && (
        <div className="account-menu-list" role="menu">
          <div className="account-menu-who">
            Signed in as <strong>{me?.name}</strong>
            <span className="muted">
              {me?.email} · {me?.role}
            </span>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setDialog("password"); }}>
            <KeyRound size={13} /> Change password
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); setDialog("two-step"); }}>
            <ShieldCheck size={13} /> {me?.twoStep ? "Two-step sign-in: on" : "Set up two-step sign-in"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              logout()
                .catch(() => undefined)
                // The gate listens for this and shows the login screen.
                .finally(() => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)))
            }
          >
            <LogOut size={13} /> Log out
          </button>
        </div>
      )}
      {dialog === "password" && <PasswordDialog onClose={() => setDialog(null)} />}
      {dialog === "two-step" && <TwoStepDialog enabled={!!me?.twoStep} onClose={() => { setDialog(null); refresh(); }} />}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal modal-narrow" role="dialog" aria-modal="true" aria-label="Change password" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-head">
          <h2>Change password</h2>
        </div>
        {done ? (
          <p className="bulk-result" role="status">Password changed. Other devices stay signed in; sign out there if you need to.</p>
        ) : (
          <div className="modal-form">
            <label>
              Current password
              <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required autoFocus />
            </label>
            <label>
              New password
              <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
              <span className="muted field-help">At least 10 characters.</span>
            </label>
            <label>
              New password again
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
            </label>
            {error && <p className="form-error">{error}</p>}
          </div>
        )}
        <div className="form-actions">
          {!done && (
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Saving…" : "Change password"}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TwoStepDialog({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offDone, setOffDone] = useState(false);

  useEffect(() => {
    if (enabled) return;
    twoStepSetup()
      .then(setSetup)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't start the setup"));
  }, [enabled]);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await twoStepConfirm(code);
      setBackupCodes(r.backupCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't match");
    } finally {
      setBusy(false);
    }
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await twoStepDisable(password);
      setOffDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn it off");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal modal-narrow" role="dialog" aria-modal="true" aria-label="Two-step sign-in" onClick={(e) => e.stopPropagation()} onSubmit={enabled ? disable : confirm}>
        <div className="modal-head">
          <h2>Two-step sign-in</h2>
        </div>
        <div className="modal-form">
          {enabled && !offDone && (
            <>
              <p className="muted">Two-step sign-in is on: after your password, you type the code from your authenticator app. Turn it off with your password.</p>
              <label>
                Your password
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
              </label>
            </>
          )}
          {offDone && <p className="bulk-result" role="status">Two-step sign-in is off.</p>}
          {!enabled && !backupCodes && (
            <>
              <p className="muted">Scan this with an authenticator app (Google Authenticator, 1Password, Authy), then type the code it shows to turn two-step sign-in on.</p>
              {setup && (
                <div className="two-step-setup">
                  <div className="two-step-qr" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
                  <p className="muted">
                    Can't scan? Enter this key by hand: <code>{setup.secret}</code>
                  </p>
                </div>
              )}
              <label>
                Code from the app
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required autoFocus />
              </label>
            </>
          )}
          {backupCodes && (
            <>
              <p className="bulk-result" role="status">Two-step sign-in is on.</p>
              <p>
                <strong>Backup codes.</strong> Each works once if you lose your phone. Save them somewhere safe; they are shown only now.
              </p>
              <ul className="backup-codes">
                {backupCodes.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="form-actions">
          {enabled && !offDone && (
            <button type="submit" className="btn-secondary" disabled={busy}>
              {busy ? "Working…" : "Turn off two-step sign-in"}
            </button>
          )}
          {!enabled && !backupCodes && (
            <button type="submit" className="btn-primary" disabled={busy || !setup}>
              {busy ? "Checking…" : "Turn on"}
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={onClose}>
            {backupCodes || offDone ? "Done" : "Cancel"}
          </button>
        </div>
      </form>
    </div>
  );
}
