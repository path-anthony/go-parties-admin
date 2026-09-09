import { useState } from "react";
import { AskGoPanel } from "./AskGoPanel";
import { NavRail } from "./NavRail";
import { ComingSoonScreen } from "./screens/ComingSoonScreen";
import { InventoryScreen } from "./screens/InventoryScreen";
import { OverviewScreen } from "./screens/OverviewScreen";

export type ScreenKey = "overview" | "inventory" | "packages" | "bookings" | "crew";

const SCREEN_TITLES: Record<ScreenKey, string> = {
  overview: "Overview",
  inventory: "Inventory",
  packages: "Packages & Themes",
  bookings: "Bookings",
  crew: "Crew & Gigs",
};

function ScreenBody({ screen }: { screen: ScreenKey }) {
  switch (screen) {
    case "overview":
      return <OverviewScreen />;
    case "inventory":
      return <InventoryScreen />;
    case "packages":
      return (
        <ComingSoonScreen
          headline="Packages & Themes"
          description={[
            "A package is a curated bundle of items with quantities, like a bill of materials — it has to be sellable and coherent on its own, no meaningless packages just to fill a slot.",
            "A theme sits on top: a curated layer mapping packages, items, decor, and copy to an occasion, like a Bluey birthday or a quinceañera. AI drafts the theme-to-package mapping; Mel approves before anything goes live.",
          ]}
        />
      );
    case "bookings":
      return (
        <ComingSoonScreen
          headline="Bookings"
          description={[
            "The CRM pipeline that sits on top of the item and package spine: Booking, Client, Contract, and Payment records tracking who booked what, the signed contract, and what's been paid.",
          ]}
        />
      );
    case "crew":
      return (
        <ComingSoonScreen
          headline="Crew & Gigs"
          description={[
            "A gig is a dated need for a human skill, sent to matching contractors favorites-first — Andy's most reliable contractors see it first.",
            "Contractors accept or counter an offer; acceptance triggers a contract automatically.",
          ]}
        />
      );
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
