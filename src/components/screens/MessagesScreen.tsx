import { MessageLogPanel } from "../MessageLogPanel";
import { MessageTemplatesPanel } from "../MessageTemplatesPanel";

// Messages is a group in the sidebar with two pages.

// What each automated text and email says, and whether it is on.
export function MessageTemplatesPage() {
  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Templates</h2>
        <p className="muted">The wording and on-off switches for every automated text and email.</p>
      </div>
      <section className="panel">
        <MessageTemplatesPanel />
      </section>
    </div>
  );
}

// Every text and email the system tried to send, newest first. This is the
// one send log; it used to be shown twice (its own screen and a Settings tab).
export function SentLogPage() {
  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Sent log</h2>
        <p className="muted">
          The last 200 texts and emails, newest first. "Sent" means handed to Twilio or the email webhook. "Not sent" means a setting
          was missing, so nothing was attempted. Click one to read it and see any error. Edit the wording under Templates.
        </p>
      </div>
      <section className="panel">
        <MessageLogPanel />
      </section>
    </div>
  );
}
