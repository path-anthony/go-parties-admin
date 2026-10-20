import { type FormEvent, useEffect, useState } from "react";
import { changeTeamRole, getTeam, getTeamAudit, inviteTeamMember, removeTeamMember, resendTeamInvite, revokeTeamInvite } from "../../lib/api";
import { useMe } from "../../lib/me";
import type { AdminRole, AuditRow, TeamUser } from "../../lib/types";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : "never");

// Settings > Team: who can sign in, with what role. Owners only; the
// server refuses everyone else.
export function TeamPage() {
  const { me } = useMe();
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("Staff");

  function load() {
    return Promise.all([getTeam(), getTeamAudit()])
      .then(([t, a]) => {
        setUsers(t.users);
        setAudit(a);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the team"));
  }
  useEffect(() => {
    void load();
  }, []);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    await run(() => inviteTeamMember({ name: name.trim(), email: email.trim(), role }), `Invite sent to ${email.trim()}.`);
    setName("");
    setEmail("");
    setRole("Staff");
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Team</h2>
        <p className="muted">Who can sign in to the admin. Owners can do everything, including this page and the business-critical settings. Staff can do everything else.</p>
      </div>
      {notice && <p className="bulk-result" role="status">{notice}</p>}
      {error && <p className="form-error">{error}</p>}

      <section className="panel">
        <h2>People</h2>
        {!users && !error && <p className="muted">Loading…</p>}
        {users && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Two-step</th>
                  <th>Last sign-in</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.name}
                      {u.id === me?.id && <span className="muted"> (you)</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>
                      <select value={u.role} disabled={busy || u.id === me?.id} onChange={(e) => run(() => changeTeamRole(u.id, e.target.value as AdminRole), `${u.name} is now ${e.target.value}.`)} aria-label={`Role for ${u.name}`}>
                        <option value="Owner">Owner</option>
                        <option value="Staff">Staff</option>
                      </select>
                    </td>
                    <td>{u.invitePending ? <span className="muted">Invite pending{u.inviteExpiresAt ? ` until ${when(u.inviteExpiresAt)}` : " (expired)"}</span> : u.twoStep ? "On" : <span className="muted">Off</span>}</td>
                    <td>{when(u.lastLoginAt)}</td>
                    <td className="team-actions">
                      {u.invitePending && (
                        <>
                          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => resendTeamInvite(u.id), `Invite resent to ${u.email}.`)}>
                            Resend invite
                          </button>
                          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => revokeTeamInvite(u.id), `Invite for ${u.email} revoked.`)}>
                            Revoke
                          </button>
                        </>
                      )}
                      {!u.invitePending && u.id !== me?.id && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Remove ${u.name}? They are signed out everywhere right away. Their name stays on the records they touched.`)) void run(() => removeTeamMember(u.id), `${u.name} removed.`);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Invite someone</h2>
        <p className="muted settings-help">They get an email with a link to set their own password. The link works once and expires after 72 hours.</p>
        <form className="add-item-form" onSubmit={invite}>
          <div className="field-row">
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </label>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
                <option value="Staff">Staff</option>
                <option value="Owner">Owner</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "Working…" : "Send invite"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Recent changes</h2>
        <p className="muted settings-help">Settings and team changes, by name. Messages, contracts, bids and lead activity carry the name in their own logs.</p>
        {audit.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="activity-list">
            {audit.map((a) => (
              <li key={a.id} className="activity-entry">
                <span className="activity-time">{when(a.createdAt)}</span>
                <strong>{a.userName}</strong> {a.action}
                {a.detail && <span className="muted">: {a.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
