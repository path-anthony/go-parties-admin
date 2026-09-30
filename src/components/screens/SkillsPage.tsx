import { SkillsEditor } from "../SkillsEditor";

// Crew & Gigs > Skills. Moved here from Settings: skills are what crew can
// do and what items need, so they live with the crew.
export function SkillsPage() {
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Skills</h2>
      </div>
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
