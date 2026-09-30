import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Sparkles } from "lucide-react";
import { NAV, type NavItem } from "../nav";

const GROUPS_KEY = "go-admin-nav-groups";

function readGroups(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeGroups(value: Record<string, boolean>) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(value));
  } catch {
    // Private windows and blocked storage just forget it.
  }
}

const inGroup = (item: NavItem, pathname: string) => !!item.pages?.some((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));

// The sidebar, built from NAV. One page is a link; two or more is a group
// that expands to its pages. Expanded (pinned) it shows labels and groups
// open inline, and each group remembers whether it was open. Collapsed to
// icons, a group's icon opens a small flyout of its pages. On a narrow
// screen it is a drawer opened from the top bar, always in the expanded
// form. The group holding the current page opens itself.
export function SideNav({
  pinned,
  onTogglePin,
  onOpenAskGo,
  mobile,
  drawerOpen,
  onCloseDrawer,
}: {
  pinned: boolean;
  onTogglePin: () => void;
  onOpenAskGo: () => void;
  mobile: boolean;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
}) {
  const { pathname } = useLocation();
  // On load, the remembered choices, with the group holding the current
  // page forced open.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const remembered = readGroups();
    const here = NAV.find((n) => inGroup(n, pathname));
    return here ? { ...remembered, [here.key]: true } : remembered;
  });
  const [flyout, setFlyout] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const expanded = pinned || mobile;

  // The group holding the current page opens itself, and the choice sticks.
  // Derived while rendering (not in an effect) so it is right on first paint.
  const active = NAV.find((n) => inGroup(n, pathname));
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setFlyout(null);
    if (active && !open[active.key]) {
      const next = { ...open, [active.key]: true };
      setOpen(next);
      writeGroups(next);
    }
  }
  const isOpen = (item: NavItem) => open[item.key] === true;

  function toggle(item: NavItem) {
    setOpen((prev) => {
      const current = prev[item.key] === true;
      const next = { ...prev, [item.key]: !current };
      writeGroups(next);
      return next;
    });
  }

  // Outside click or Escape closes the flyout.
  useEffect(() => {
    if (!flyout) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setFlyout(null);
        return;
      }
      if (!navRef.current?.contains(e.target as Node)) setFlyout(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [flyout]);

  const classes = ["nav-rail", expanded ? "nav-rail-pinned" : "", mobile ? "nav-rail-drawer" : "", mobile && drawerOpen ? "nav-rail-drawer-open" : ""].filter(Boolean).join(" ");

  return (
    <>
      {mobile && drawerOpen && <div className="nav-backdrop" onClick={onCloseDrawer} aria-hidden="true" />}
      <nav ref={navRef} className={classes} aria-label="Main">
        {!mobile && (
          <>
            <button type="button" className="nav-item nav-toggle" onClick={onTogglePin} aria-label={pinned ? "Collapse navigation" : "Pin navigation open"}>
              {pinned ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
              {pinned ? <span className="nav-label">Collapse</span> : <span className="nav-tooltip">Expand</span>}
            </button>
            <div className="nav-divider" />
          </>
        )}

        <ul className="nav-list">
          {NAV.map((item) => {
            const Icon = item.icon;
            if (!item.pages) {
              return (
                <li key={item.key}>
                  <NavLink to={item.path} className={({ isActive }) => (isActive ? "nav-item nav-item-active" : "nav-item")} aria-label={item.label} onClick={onCloseDrawer}>
                    <Icon size={18} />
                    {expanded ? <span className="nav-label">{item.label}</span> : <span className="nav-tooltip">{item.label}</span>}
                  </NavLink>
                </li>
              );
            }
            const within = inGroup(item, pathname);
            const groupOpen = isOpen(item);
            return (
              <li key={item.key} className="nav-group">
                <button
                  type="button"
                  className={within ? "nav-item nav-item-within" : "nav-item"}
                  aria-label={item.label}
                  aria-expanded={expanded ? groupOpen : flyout === item.key}
                  aria-haspopup={expanded ? undefined : "menu"}
                  onClick={() => (expanded ? toggle(item) : setFlyout(flyout === item.key ? null : item.key))}
                >
                  <Icon size={18} />
                  {expanded ? (
                    <>
                      <span className="nav-label">{item.label}</span>
                      {groupOpen ? <ChevronDown size={14} className="nav-chevron" /> : <ChevronRight size={14} className="nav-chevron" />}
                    </>
                  ) : (
                    flyout !== item.key && <span className="nav-tooltip">{item.label}</span>
                  )}
                </button>
                {expanded && groupOpen && (
                  <ul className="nav-sublist">
                    {item.pages.map((page) => (
                      <li key={page.path}>
                        <NavLink to={page.path} className={({ isActive }) => (isActive ? "nav-subitem nav-subitem-active" : "nav-subitem")} onClick={onCloseDrawer}>
                          {page.label}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
                {!expanded && flyout === item.key && (
                  <div className="nav-flyout" role="menu" aria-label={item.label}>
                    <div className="nav-flyout-title">{item.label}</div>
                    {item.pages.map((page) => (
                      <NavLink key={page.path} to={page.path} role="menuitem" className={({ isActive }) => (isActive ? "nav-subitem nav-subitem-active" : "nav-subitem")} onClick={() => setFlyout(null)}>
                        {page.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="nav-spacer" />

        <button
          type="button"
          className="nav-item nav-askgo"
          onClick={() => {
            onCloseDrawer();
            onOpenAskGo();
          }}
          aria-label="Ask GO"
        >
          <Sparkles size={18} />
          {expanded ? <span className="nav-label">Ask GO</span> : <span className="nav-tooltip">Ask GO</span>}
        </button>
      </nav>
    </>
  );
}
