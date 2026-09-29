import type { AgreementInfo } from "../lib/types";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

// What the customer agreed to, in a few words: agreed with the box ticked,
// the box not ticked, or no agreement on file (bookings made before this
// existed). The title carries the version and the time.
export function AgreementChip({ agreement }: { agreement: AgreementInfo | null }) {
  if (!agreement) {
    return (
      <span className="achip achip-none" title="Made before agreements were recorded">
        No agreement on file
      </span>
    );
  }
  const title = `Policy version ${agreement.policyVersion.version}, ${when(agreement.agreedAt)} Eastern`;
  return agreement.checkboxChecked ? (
    <span className="achip achip-yes" title={title}>
      Agreed · policy v{agreement.policyVersion.version}
    </span>
  ) : (
    <span className="achip achip-unchecked" title={title}>
      Box not ticked · policy v{agreement.policyVersion.version}
    </span>
  );
}

export function BalanceLabel({ preference }: { preference: string }) {
  return <span className="muted balance-label">Balance: {preference}</span>;
}
