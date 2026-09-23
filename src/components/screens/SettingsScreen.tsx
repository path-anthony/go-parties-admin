import { LeadColumnsEditor } from "../LeadColumnsEditor";
import { SkillsEditor } from "../SkillsEditor";

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

      <section className="panel">
        <h2>Crew skills</h2>
        <p className="muted settings-help">
          What an item can need and what a crew member can do. The item popup, the new-item form, the crew popup and
          Bulk add all read this list. Renaming a skill renames it on every item, crew member and gig. A skill can't be
          deleted while an item or a crew member still lists it.
        </p>
        <SkillsEditor />
      </section>
    </div>
  );
}
