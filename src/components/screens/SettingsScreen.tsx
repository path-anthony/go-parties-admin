import { LeadColumnsEditor } from "../LeadColumnsEditor";
import { GoSignerSettings } from "../GoSignerSettings";
import { NotificationSettings } from "../NotificationSettings";
import { PolicyEditor } from "../PolicyEditor";
import { ReviewSettings } from "../ReviewSettings";
import { RushSettings } from "../RushSettings";
import { SkillsEditor } from "../SkillsEditor";

export function SettingsScreen() {
  return (
    <div className="screen">
      <div className="screen-head">
        <h2>Settings</h2>
      </div>

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
        <h2>Notifications and reminders</h2>
        <p className="muted settings-help">
          Who hears about a signed contract, and the balance reminder window. Texts go through Twilio and emails through the email
          webhook; the Messages screen shows what actually went.
        </p>
        <NotificationSettings />
      </section>

      <section className="panel">
        <h2>Contract signature for GO</h2>
        <p className="muted settings-help">
          Who signs contracts on GO's behalf. Applied automatically, as a second signature block, when a customer signs.
        </p>
        <GoSignerSettings />
      </section>

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
