import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { checkMapsAddress, getIntegrationStatus, getLeadStatuses, type IntegrationStatus, type MapsCheck } from "../../lib/api";
import { stageWarnings } from "../../lib/leadStages";
import { statusLabel } from "../../lib/messages";
import { useIsOwner } from "../../lib/me";
import { EDITOR_COPY, type PageSpec, type PanelKey, type SectionSpec, pageById } from "../../settingsCopy";
import { ContractTermsEditor } from "../ContractTermsEditor";
import { GoogleCalendarCard } from "../GoogleCalendarCard";
import { HeroPhotos } from "../HeroPhotos";
import { LeadColumnsEditor } from "../LeadColumnsEditor";
import { LogoField } from "../LogoField";
import { PolicyEditor } from "../PolicyEditor";
import { ServiceRowsEditor } from "../ServiceRowsEditor";
import { SettingsForm } from "../SettingsForm";

// Settings is a group in the sidebar; each of these is one of its pages,
// with its own address. Block A12: every page is drawn from src/settingsCopy.ts
// (title, one-line intro, each section's line, each field's label and help),
// and each section saves only the fields it shows.

// ownerOnly pages: Staff see everything but can change nothing. A disabled
// fieldset switches off every control inside; the server refuses the
// writes anyway (403, same sentence).
function Page({ title, intro, ownerOnly, children }: { title: string; intro?: string; ownerOnly?: boolean; children: ReactNode }) {
  const isOwner = useIsOwner();
  const readOnly = !!ownerOnly && !isOwner;
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>{title}</h2>
        {intro && <p className="muted">{intro}</p>}
        {readOnly && (
          <p className="stage-warning" role="note">
            Only owners can change this.
          </p>
        )}
      </div>
      {readOnly ? (
        <fieldset className="readonly-fieldset" disabled>
          {children}
        </fieldset>
      ) : (
        children
      )}
    </div>
  );
}

// A short list of links to the sections of a longer page. These are links to
// places on the same page, not tabs.
function JumpLinks({ page }: { page: PageSpec }) {
  if (page.sections.length < 4) return null;
  return (
    <nav className="settings-jump" aria-label="On this page">
      <span className="detail-field-label">On this page</span>
      {page.sections.map((s) => (
        <a key={s.id} href={`#${s.id}`}>
          {s.title}
        </a>
      ))}
    </nav>
  );
}

function SectionView({ section, children }: { section: SectionSpec; children?: ReactNode }) {
  return (
    <section className="panel" id={section.id}>
      <h2>{section.title}</h2>
      <p className="muted settings-help">{section.blurb}</p>
      {children}
    </section>
  );
}

function marked(key: string, children: ReactNode) {
  return <div data-setting={key}>{children}</div>;
}

function LeadColumnsPanel() {
  // Live column names, so the warning follows a rename or delete as it happens.
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    getLeadStatuses()
      .then((rows) => setNames(rows.map((r) => r.name)))
      .catch(() => setNames(null));
  }, []);
  const warnings = names ? stageWarnings(names) : [];
  return (
    <div data-setting="panel:leadColumns">
      <p className="muted stage-note">{EDITOR_COPY.leadColumns.note}</p>
      {warnings.map((w) => (
        <p key={w} className="stage-warning" role="alert">
          {w}
        </p>
      ))}
      <LeadColumnsEditor onColumnsChange={(rows) => setNames(rows.map((r) => r.name))} />
    </div>
  );
}

function TemplatesLink() {
  return (
    <div className="form-actions">
      <Link to="/messages/templates" className="btn-secondary">
        {EDITOR_COPY.templatesLink.button}
      </Link>
      <span className="muted field-help">{EDITOR_COPY.templatesLink.help}</span>
    </div>
  );
}

const signerNote = (v: Record<string, string>) => ((v.authorizedSignerName.trim() === "") !== (v.authorizedSignerTitle.trim() === "") ? EDITOR_COPY.signer.half : EDITOR_COPY.signer.ok);

const PANELS: Partial<Record<PanelKey, ReactNode>> = {
  logo: <LogoField />,
  policy: marked("panel:policy", <PolicyEditor />),
  terms: marked("panel:contractTerms", <ContractTermsEditor />),
  services: marked("panel:serviceRows", <ServiceRowsEditor />),
  leadColumns: <LeadColumnsPanel />,
  templatesLink: <TemplatesLink />,
  homePhotos: marked("panel:homePhotos", <HeroPhotos />),
};

function SettingsPage({ id, ownerOnly }: { id: string; ownerOnly?: boolean }) {
  const page = pageById(id);
  return (
    <Page title={page.title} ownerOnly={ownerOnly} intro={page.intro}>
      <JumpLinks page={page} />
      {page.sections.map((s) => (
        <SectionView key={s.id} section={s}>
          {s.fields && <SettingsForm fields={s.fields} note={s.id === "signer" ? signerNote : undefined} />}
          {s.panel && PANELS[s.panel]}
        </SectionView>
      ))}
    </Page>
  );
}

export const BusinessPage = () => <SettingsPage id="business" ownerOnly />;
export const BookingRulesPage = () => <SettingsPage id="booking-rules" ownerOnly />;
export const ContractAndPolicyPage = () => <SettingsPage id="contract-and-policy" ownerOnly />;
export const MessagesAndNotificationsPage = () => <SettingsPage id="notifications" />;
export const HomePhotosPage = () => <SettingsPage id="home-photos" />;

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

// Block A9: try an address against Google, the way the storefront hold
// does. One lookup, counted against the day and cached.
function MapsCheckForm() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MapsCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await checkMapsAddress(address));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="add-item-form" onSubmit={submit}>
      <label>
        Try an address
        <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} placeholder="767 New Britain Ave, Farmington, CT" disabled={busy} />
        <span className="muted field-help">Type an address to see what Google finds. Each test counts as one lookup.</span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn-secondary" disabled={busy || address.trim() === ""}>
          Look it up
        </button>
      </div>
      {error && <span className="form-error">{error}</span>}
      {result && (
        <span className="muted field-help">
          {result.exact === true && `Exact: ${result.formattedAddress} (place ${result.placeId}${result.cached ? ", from the cache" : ""}).`}
          {result.exact === false && `Not exact: ${result.reason}`}
          {result.exact === null && `Not checked: ${result.reason}`}
        </span>
      )}
    </form>
  );
}

// Read only: what is hooked up. No keys or numbers are shown, only yes or no
// and how the last send went. Google Calendar is set up here.
export function IntegrationsPage() {
  const page = pageById("integrations");
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getIntegrationStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the status"));
  }, []);

  const last = (l: IntegrationStatus["texting"]["last"], none: string) =>
    l ? `${statusLabel(l.status)}, ${when(l.createdAt)} ET${l.confirmation === "delivered" ? ", delivered" : ""}` : none;

  const loading = !status ? <p className="muted">{error ? "" : "Loading…"}</p> : null;
  const panels: Partial<Record<PanelKey, ReactNode>> = {
    statusText: marked(
      "panel:statusText",
      loading ?? (
        <ul className="addon-list">
          <StatusLine label="Text messaging is set up" ok={status!.texting.configured} />
          {!status!.texting.configured && (
            <li className="muted">
              Still needed:{" "}
              {[!status!.texting.parts.accountId && "the account ID", !status!.texting.parts.authToken && "the auth token", !status!.texting.parts.phoneNumber && "the sending phone number"].filter(Boolean).join(", ")}. Until then, texts are logged as not sent.
            </li>
          )}
          <li className="unit-row">
            <span>
              <strong>Last text</strong>
            </span>
            <span>{last(status!.texting.last, "None yet")}</span>
          </li>
        </ul>
      ),
    ),
    statusEmail: marked(
      "panel:statusEmail",
      loading ?? (
        <ul className="addon-list">
          <StatusLine label="Email is set up" ok={status!.email.configured} detail={status!.email.configured ? undefined : "no email address to send through yet"} />
          <li className="unit-row">
            <span>
              <strong>Last email</strong>
            </span>
            <span>{last(status!.email.last, "None yet")}</span>
          </li>
        </ul>
      ),
    ),
    statusAutomation: marked(
      "panel:statusAutomation",
      loading ?? (
        <ul className="addon-list">
          <li className="unit-row">
            <span>
              <strong>Last check</strong>
            </span>
            <span>
              {status!.automation.last
                ? `${when(status!.automation.last.ranAt)} ET, ${status!.automation.last.source === "admin" ? "run by staff" : "hourly timer"}${automationCounts(status!.automation.last.summary)}`
                : "Never. The hourly timer has not called yet."}
            </span>
          </li>
          <li className="unit-row">
            <span>
              <strong>Needs attention</strong>
            </span>
            <span>{status!.automation.needsAttention} failed after 3 tries</span>
          </li>
        </ul>
      ),
    ),
    statusStripe: marked(
      "panel:statusStripe",
      loading ?? (
        <ul className="addon-list">
          <StatusLine label={status!.stripe.configured ? `Online payment is set up, ${status!.stripe.mode === "live" ? "live mode" : "test mode"}` : "Online payment not set up"} ok={status!.stripe.configured} />
          {!status!.stripe.configured && (
            <li className="muted">
              Still needed: {[!status!.stripe.parts.secretKey && "the secret key", !status!.stripe.parts.webhookSecret && "the webhook signing secret"].filter(Boolean).join(", ")}. Until then checkout holds the date and GO collects the retainer by hand.
            </li>
          )}
          <li className="unit-row">
            <span>
              <strong>Last payment notice from Stripe</strong>
            </span>
            <span>{status!.stripe.lastWebhookAt ? `${when(status!.stripe.lastWebhookAt)} ET` : "None yet"}</span>
          </li>
          <li className="unit-row">
            <span>
              <strong>Last error</strong>
            </span>
            <span className={status!.stripe.lastError ? "form-error" : "muted"}>{status!.stripe.lastError ?? "None"}</span>
          </li>
        </ul>
      ),
    ),
    statusMaps: marked(
      "panel:statusMaps",
      loading ?? (
        <>
          <ul className="addon-list">
            <StatusLine label="Maps connected" ok={status!.maps.configured} detail={status!.maps.configured ? undefined : "addresses are saved as typed and marked not checked"} />
            <li className="unit-row">
              <span>
                <strong>Lookups today</strong>
                <span className="muted"> · paused for the day at {status!.maps.dailyCap}; answers are kept 30 days</span>
              </span>
              <span>
                {status!.maps.todayLookups} of {status!.maps.dailyCap}
              </span>
            </li>
            <li className="unit-row">
              <span>
                <strong>Last error</strong>
              </span>
              <span>{status!.maps.lastError ? `${status!.maps.lastError} (${when(status!.maps.lastErrorAt ?? "")} ET)` : "None"}</span>
            </li>
          </ul>
          <MapsCheckForm />
        </>
      ),
    ),
    googleCalendar: marked("panel:googleCalendar", <GoogleCalendarCard />),
    statusStorefront: marked(
      "panel:statusStorefront",
      loading ?? (
        <ul className="addon-list">
          <StatusLine label="Storefront web address is set" ok={status!.storefront.urlSet} detail={status!.storefront.urlSet ? undefined : "contract links will point at the wrong place"} />
        </ul>
      ),
    ),
  };

  return (
    <Page title={page.title} ownerOnly intro={page.intro}>
      {error && <p className="form-error">{error}</p>}
      <JumpLinks page={page} />
      {page.sections.map((s) => (
        <SectionView key={s.id} section={s}>
          {s.panel && panels[s.panel]}
        </SectionView>
      ))}
    </Page>
  );
}
