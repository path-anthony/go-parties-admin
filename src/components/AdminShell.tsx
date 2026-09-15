import { useState } from "react";
import { AskGoPanel } from "./AskGoPanel";
import { NavRail } from "./NavRail";
import { BookingsScreen } from "./screens/BookingsScreen";
import { EmptyScreen } from "./screens/EmptyScreen";
import { InventoryScreen } from "./screens/InventoryScreen";
import { OverviewScreen } from "./screens/OverviewScreen";
import { SchedulingScreen } from "./screens/SchedulingScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export type ScreenKey = "overview" | "inventory" | "packages" | "bookings" | "scheduling" | "crew" | "settings";

const SCREEN_TITLES: Record<ScreenKey, string> = {
  overview: "Overview",
  inventory: "Inventory",
  packages: "Packages & Themes",
  bookings: "Bookings",
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
    case "bookings":
      return <BookingsScreen />;
    case "scheduling":
      return <SchedulingScreen />;
    case "settings":
      return <SettingsScreen />;
    case "packages":
    case "crew":
      return <EmptyScreen title={SCREEN_TITLES[screen]} />;
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
        </header>
        <div className="admin-content">
          <ScreenBody screen={screen} />
        </div>
      </div>
      <AskGoPanel open={askGoOpen} onClose={() => setAskGoOpen(false)} />
    </div>
  );
}
