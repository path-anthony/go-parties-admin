import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { LogOut, Menu } from "lucide-react";
import { AUTH_EXPIRED_EVENT, logout } from "../lib/api";
import { NavigationContext, type ScreenKey, type ScreenParams } from "../lib/navigation";
import { LEGACY_REDIRECTS, LEGACY_TABS, NAV, GroupRoot, breadcrumbFor, screenToPath } from "../nav";
import { AskGoPanel } from "./AskGoPanel";
import { SideNav } from "./SideNav";

const PIN_KEY = "go-admin-nav-pinned";
const NARROW = "(max-width: 700px)";

function usePinned(): [boolean, () => void] {
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(PIN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setPinned((p) => {
      try {
        localStorage.setItem(PIN_KEY, p ? "0" : "1");
      } catch {
        // storage blocked: the choice just doesn't stick
      }
      return !p;
    });
  return [pinned, toggle];
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

// Frame for every page: sidebar, top bar with the breadcrumb, and the
// routes. Every page in NAV is its own address.
export function AdminShell() {
  const location = useLocation();
  const go = useNavigate();
  const [pinned, togglePin] = usePinned();
  const narrow = useNarrow();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [askGoOpen, setAskGoOpen] = useState(false);
  // A visit counter keys the page, so being sent to the page you are already
  // on with new filters (an Overview card) reloads it fresh.
  const [visit, setVisit] = useState(0);

  const navigate = useCallback(
    (screen: ScreenKey, params?: ScreenParams) => {
      setVisit((v) => v + 1);
      go(screenToPath(screen, params));
    },
    [go],
  );

  const crumbs = breadcrumbFor(location.pathname);

  return (
    <NavigationContext.Provider value={navigate}>
      <div className="admin-shell">
        <SideNav pinned={pinned} onTogglePin={togglePin} onOpenAskGo={() => setAskGoOpen(true)} mobile={narrow} drawerOpen={drawerOpen} onCloseDrawer={() => setDrawerOpen(false)} />
        <div className="admin-main">
          <header className="admin-topbar">
            {narrow && (
              <button type="button" className="icon-btn nav-hamburger" onClick={() => setDrawerOpen((o) => !o)} aria-label="Open menu" aria-expanded={drawerOpen}>
                <Menu size={18} />
              </button>
            )}
            <span className="wordmark">
              <span className="wordmark-go">GO!</span> EVENT GROUP
            </span>
            <nav className="admin-breadcrumb" aria-label="Breadcrumb">
              {crumbs.map((c, i) => (
                <span key={c.label} className="admin-crumb">
                  <span className="admin-topbar-divider">/</span>
                  {c.to && i < crumbs.length - 1 ? (
                    <Link to={c.to} className="admin-topbar-title admin-crumb-link">
                      {c.label}
                    </Link>
                  ) : (
                    <span className="admin-topbar-title" aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                      {c.label}
                    </span>
                  )}
                </span>
              ))}
            </nav>
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
              <LogOut size={13} /> <span className="admin-logout-text">Log out</span>
            </button>
          </header>
          <div className="admin-content">
            <Routes>
              {NAV.flatMap((item) =>
                item.pages
                  ? [
                      <Route key={item.path} path={item.path} element={<GroupRoot item={item} tabs={LEGACY_TABS[item.path]} />} />,
                      ...item.pages.map((page) => <Route key={page.path} path={page.path} element={<div key={visit}>{page.element}</div>} />),
                    ]
                  : [<Route key={item.path} path={item.path} element={<div key={visit}>{item.element}</div>} />],
              )}
              {LEGACY_REDIRECTS.map(([from, to]) => (
                <Route key={from} path={from} element={<Navigate to={to} replace />} />
              ))}
              <Route path="*" element={<Navigate to="/overview" replace />} />
            </Routes>
          </div>
        </div>
        <AskGoPanel open={askGoOpen} onClose={() => setAskGoOpen(false)} />
      </div>
    </NavigationContext.Provider>
  );
}
