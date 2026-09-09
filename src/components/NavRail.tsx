import type { LucideIcon } from "lucide-react";
import { Box, Briefcase, ChartBar, Contact, Layers2, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import type { ScreenKey } from "./AdminShell";

const NAV_ITEMS: { key: ScreenKey; label: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Overview", icon: ChartBar },
  { key: "inventory", label: "Inventory", icon: Box },
  { key: "packages", label: "Packages & Themes", icon: Layers2 },
  { key: "bookings", label: "Bookings", icon: Contact },
  { key: "crew", label: "Crew & Gigs", icon: Briefcase },
];

export function NavRail({
  active,
  onNavigate,
  pinned,
  onTogglePin,
  onOpenAskGo,
}: {
  active: ScreenKey;
  onNavigate: (screen: ScreenKey) => void;
  pinned: boolean;
  onTogglePin: () => void;
  onOpenAskGo: () => void;
}) {
  return (
    <nav className={pinned ? "nav-rail nav-rail-pinned" : "nav-rail"}>
      <button
        type="button"
        className="nav-item nav-toggle"
        onClick={onTogglePin}
        aria-label={pinned ? "Collapse navigation" : "Pin navigation open"}
      >
        {pinned ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        {pinned ? <span className="nav-label">Collapse</span> : <span className="nav-tooltip">Expand</span>}
      </button>

      <div className="nav-divider" />

      <ul className="nav-list">
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <li key={key}>
            <button
              type="button"
              className={key === active ? "nav-item nav-item-active" : "nav-item"}
              onClick={() => onNavigate(key)}
              aria-current={key === active ? "page" : undefined}
              aria-label={label}
            >
              <Icon size={18} />
              {pinned ? <span className="nav-label">{label}</span> : <span className="nav-tooltip">{label}</span>}
            </button>
          </li>
        ))}
      </ul>

      <div className="nav-spacer" />

      <button type="button" className="nav-item nav-askgo" onClick={onOpenAskGo} aria-label="Ask GO">
        <Sparkles size={18} />
        {pinned ? <span className="nav-label">Ask GO</span> : <span className="nav-tooltip">Ask GO</span>}
      </button>
    </nav>
  );
}
