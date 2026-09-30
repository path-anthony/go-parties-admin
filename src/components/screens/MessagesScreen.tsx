import { MessageLogPanel } from "../MessageLogPanel";

// The send log on its own screen (also under Settings > Message log).
export function MessagesScreen() {
  return (
    <div className="screen screen-wide">
      <div className="screen-head">
        <h2>Messages</h2>
        <p className="muted">
          Every text and email the system tried to send, newest first. "Sent" means handed to Twilio or the email webhook. "Not sent"
          means a setting was missing, so nothing was attempted. Edit the wording under Settings, Messages.
        </p>
      </div>
      <section className="panel">
        <MessageLogPanel />
      </section>
    </div>
  );
}
