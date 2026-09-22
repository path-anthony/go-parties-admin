import { useState } from "react";
import { LogOut } from "lucide-react";
import { AUTH_EXPIRED_EVENT, logout } from "../lib/api";
import { AskGoPanel } from "./AskGoPanel";
import { NavRail } from "./NavRail";
import { LeadsScreen } from "./screens/LeadsScreen";
import { CrewGigsScreen } from "./screens/CrewGigsScreen";
import { InventoryScreen } from "./screens/InventoryScreen";
import { OverviewScreen } from "./screens/OverviewScreen";
import { PackagesScreen } from "./screens/PackagesScreen";
import { SchedulingScreen } from "./screens/SchedulingScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export type ScreenKey = "overview" | "inventory" | "packages" | "leads" | "scheduling" | "crew" | "settings";

const SCREEN_TITLES: Record<ScreenKey, string> = {
  overview: "Overview",
  inventory: "Inventory",
  packages: "Packages & Themes",
  leads: "Leads",
  scheduling: "Scheduling",
  crew: "Crew & Gigs",
  settings: "Settings",
};

function ScreenBody({ screen }: { screen: ScreenKey }) {
  switch (screen) {
    case "overview":
      return <OverviewScreen />;
    case "inventory":
      return <InventoryScreen />;
    case "leads":
      return <LeadsScreen />;
    case "scheduling":
      return <SchedulingScreen />;
    case "settings":
      return <SettingsScreen />;
    case "packages":
      return <PackagesScreen />;
    case "crew":
      return <CrewGigsScreen />;
  }
}

export function AdminShell() {
  const [screen, setScreen] = useState<ScreenKey>("overview");
  const [pinned, setPinned] = useState(false);
  const [askGoOpen, setAskGoOpen] = useState(false);

  return (
    <div className="admin-shell">
      <NavRail
        active={screen}
        onNavigate={setScreen}
        pinned={pinned}
        onTogglePin={() => setPinned((p) => !p)}
        onOpenAskGo={() => setAskGoOpen(true)}
      />
      <div className="admin-main">
        <header className="admin-topbar">
          <span className="wordmark">
            <span className="wordmark-go">GO!</span> EVENT GROUP
          </span>
          <span className="admin-topbar-divider">/</span>
          <span className="admin-topbar-title">{SCREEN_TITLES[screen]}</span>
          <button
            type="button"
            className="btn-secondary admin-logout"
            onClick={() =>
              logout()
                .catch(() => undefined)
                // The gate listens for this and shows the login screen.
                .finally(() => window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)))
            }
          >
            <LogOut size={13} /> Log out
          </button>
        </header>
        <div className="admin-content">
          <ScreenBody screen={screen} />
        </div>
      </div>
      <AskGoPanel open={askGoOpen} onClose={() => setAskGoOpen(false)} />
    </div>
  );
}
