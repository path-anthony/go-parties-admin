import { type ReactNode, useCallback, useEffect, useState } from "react";
import { AUTH_EXPIRED_EVENT, getAuthStatus } from "../lib/api";
import { MeContext } from "../lib/me";
import type { AdminUser } from "../lib/types";
import { LoginScreen } from "./LoginScreen";
import { SetPasswordScreen } from "./SetPasswordScreen";

type Status = "checking" | "authenticated" | "unauthenticated";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [me, setMe] = useState<AdminUser | null>(null);

  const refresh = useCallback(() => {
    getAuthStatus()
      .then((res) => {
        setMe(res.user);
        setStatus(res.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => setStatus("unauthenticated"));
  }, []);

  useEffect(() => {
    refresh();
    function handleExpired() {
      setMe(null);
      setStatus("unauthenticated");
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
  }, [refresh]);

  // An invite or reset link lands here signed out; the page is public.
  if (window.location.pathname === "/set-password") {
    return <SetPasswordScreen onDone={refresh} />;
  }

  if (status === "checking") {
    return (
      <div className="login-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <LoginScreen
        onSuccess={(user) => {
          setMe(user ?? null);
          setStatus("authenticated");
          if (!user) refresh();
        }}
      />
    );
  }

  return <MeContext.Provider value={{ me, refresh }}>{children}</MeContext.Provider>;
}
