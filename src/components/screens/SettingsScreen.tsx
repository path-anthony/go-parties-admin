import { LeadColumnsEditor } from "../LeadColumnsEditor";

export function SettingsScreen() {
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Settings</h2>
      </div>

      <section className="panel">
        <h2>Lead columns</h2>
        <p className="muted settings-help">
          The stages on the Leads board, in order. New leads land in the first one. Renaming a column moves its
          leads with it. A column can't be deleted while it still has leads.
        </p>
        <LeadColumnsEditor />
      </section>
    </div>
  );
}
