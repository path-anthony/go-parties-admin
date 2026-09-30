import { useEffect, useState } from "react";
import { getIntegrationStatus, getLeadStatuses, type IntegrationStatus } from "../../lib/api";
import { stageWarnings, LOST_STAGE, WON_STAGE } from "../../lib/leadStages";
import { statusLabel } from "../../lib/messages";
import { GoSignerSettings } from "../GoSignerSettings";
import { LeadColumnsEditor } from "../LeadColumnsEditor";
import { NotificationSettings } from "../NotificationSettings";
import { PolicyEditor } from "../PolicyEditor";
import { ReviewSettings } from "../ReviewSettings";
import { RushSettings } from "../RushSettings";

// Settings is a group in the sidebar; each of these is one of its pages,
// with its own address. The panels are the same ones that used to be
// stacked on one long page, unchanged.

function Page({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>{title}</h2>
        {intro && <p className="muted">{intro}</p>}
      </div>
      {children}
    </div>
  );
}

export function BusinessRulesPage() {
  return (
    <Page title="Business rules" intro="How short-notice bookings and big or special bookings are handled, and the deposit share.">
      <section className="panel">
        <h2>Rush orders</h2>
        <p className="muted settings-help">
          Bookings made, or moved, with less notice than this are tagged RUSH in Scheduling, Overview, Crew &amp; Gigs and
          the lead panel so they can be handled differently. The storefront reads both values.
        </p>
        <RushSettings />
      </section>

      <section className="panel">
        <h2>Review and deposit</h2>
        <p className="muted settings-help">
          Which bookings go to Design Requests for staff to look at before anything is held, and the deposit share. The
          storefront reads all of it.
        </p>
        <ReviewSettings />
      </section>
    </Page>
  );
}

export function PoliciesPage() {
  return (
    <Page title="Policies and contracts" intro="What customers agree to, and who signs for GO.">
      <section className="panel">
        <h2>Cancellation and deposit policy</h2>
        <p className="muted settings-help">
          The text customers agree to, and the policy section of every contract. Each save is a new version, and every agreement
          records the version the customer saw. Merge fields fill in from the booking when a contract is made:{" "}
          <code>{"{{customer_name}} {{event_date}} {{event_time}} {{event_address}} {{total}} {{deposit_percentage}} {{deposit_amount}} {{balance_amount}} {{cancellation_window_days}}"}</code>
          . camelCase spellings work too (<code>{"{{depositPercentage}}"}</code>, which fills in a bare number, so write the % yourself). Anything else in double braces is left as typed.
        </p>
        <PolicyEditor />
      </section>

      <section className="panel">
        <h2>Contract signature for GO</h2>
        <p className="muted settings-help">
          Who signs contracts on GO's behalf. Applied automatically, as a second signature block, when a customer signs.
        </p>
        <GoSignerSettings />
      </section>
    </Page>
  );
}

export function LeadPipelinePage() {
  // Live column names, so the warning follows a rename or delete as it happens.
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    getLeadStatuses()
      .then((rows) => setNames(rows.map((r) => r.name)))
      .catch(() => setNames(null));
  }, []);
  const warnings = names ? stageWarnings(names) : [];
  return (
    <Page title="Lead pipeline">
      <section className="panel">
        <h2>Lead columns</h2>
        <p className="muted settings-help">
          The stages on the Leads board, in order. New leads land in the first one. Renaming a column moves its
          leads with it. A column can't be deleted while it still has leads.
        </p>
        <p className="muted stage-note">
          For follow-up messages, the "{WON_STAGE}" column counts as won and the "{LOST_STAGE}" column counts as lost. A lead in either one stops getting follow-ups,
          and so does any lead that has a booking. Columns are matched by name, so keep these two names.
        </p>
        {warnings.map((w) => (
          <p key={w} className="stage-warning" role="alert">
            {w}
          </p>
        ))}
        <LeadColumnsEditor onColumnsChange={(rows) => setNames(rows.map((r) => r.name))} />
      </section>
    </Page>
  );
}

export function NotificationsPage() {
  return (
    <Page title="Notifications" intro="Who is told when a contract is signed, and how far ahead of an event the balance reminder check looks.">
      <section className="panel">
        <h2>Staff notifications and reminders</h2>
        <p className="muted settings-help">
          The staff notification phone and email below are where the "contract signed" heads-up goes. Texts go through Twilio and
          emails through the email webhook; Messages, Sent log shows what actually went.
        </p>
        <NotificationSettings />
      </section>
    </Page>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

function automationCounts(summary: NonNullable<IntegrationStatus["automation"]["last"]>["summary"]): string {
  const t = (summary as { counts?: { total?: { sent: number; failed: number; blocked: number; skipped: number } } }).counts?.total;
  return t ? `: ${t.sent} sent, ${t.failed} failed, ${t.blocked} blocked, ${t.skipped} skipped` : "";
}

function StatusLine({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <li className="unit-row">
      <span>
        <strong>{label}</strong>
        {detail && <span className="muted"> · {detail}</span>}
      </span>
      <span className={`msg-status ${ok ? "msg-sent" : "msg-skipped"}`}>{ok ? "Yes" : "Not yet"}</span>
    </li>
  );
}

// Read only: what is hooked up. No keys or numbers are shown, only yes or no
// and how the last send went.
export function IntegrationsPage() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getIntegrationStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the status"));
  }, []);

  const last = (l: IntegrationStatus["texting"]["last"], none: string) =>
    l ? `${statusLabel(l.status)}, ${when(l.createdAt)} ET${l.confirmation === "delivered" ? ", delivered" : ""}` : none;

  return (
    <Page title="Integrations" intro="What is connected. This page only reports; nothing here can be changed.">
      {error && <p className="form-error">{error}</p>}
      {!status && !error && <p className="muted">Loading…</p>}
      {status && (
        <>
          <section className="panel">
            <h2>Text messaging</h2>
            <ul className="addon-list">
              <StatusLine label="Text messaging is set up" ok={status.texting.configured} />
              {!status.texting.configured && (
                <li className="muted">
                  Still needed:{" "}
                  {[!status.texting.parts.accountId && "the account ID", !status.texting.parts.authToken && "the auth token", !status.texting.parts.phoneNumber && "the sending phone number"]
                    .filter(Boolean)
                    .join(", ")}
                  . Until then, texts are logged as not sent.
                </li>
              )}
              <li className="unit-row">
                <span>
                  <strong>Last text</strong>
                </span>
                <span>{last(status.texting.last, "None yet")}</span>
              </li>
            </ul>
          </section>
          <section className="panel">
            <h2>Email</h2>
            <ul className="addon-list">
              <StatusLine label="Email is set up" ok={status.email.configured} detail={status.email.configured ? undefined : "no email address to send through yet"} />
              <li className="unit-row">
                <span>
                  <strong>Last email</strong>
                </span>
                <span>{last(status.email.last, "None yet")}</span>
              </li>
            </ul>
          </section>
          <section className="panel">
            <h2>Automation check</h2>
            <ul className="addon-list">
              <li className="unit-row">
                <span>
                  <strong>Last automation check</strong>
                </span>
                <span>
                  {status.automation.last
                    ? `${when(status.automation.last.ranAt)} ET, ${status.automation.last.source === "admin" ? "run by staff" : "hourly timer"}${automationCounts(status.automation.last.summary)}`
                    : "Never. The hourly timer has not called yet."}
                </span>
              </li>
              <li className="unit-row">
                <span>
                  <strong>Needs attention</strong>
                </span>
                <span>{status.automation.needsAttention} failed after 3 tries</span>
              </li>
            </ul>
          </section>
          <section className="panel">
            <h2>Storefront</h2>
            <ul className="addon-list">
              <StatusLine label="Storefront web address is set" ok={status.storefront.urlSet} detail={status.storefront.urlSet ? undefined : "contract links will point at the wrong place"} />
            </ul>
          </section>
        </>
      )}
    </Page>
  );
}
