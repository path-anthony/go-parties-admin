import { type ReactNode, useEffect, useState } from "react";
import { AUTH_EXPIRED_EVENT, getAuthStatus } from "../lib/api";
import { LoginScreen } from "./LoginScreen";

type Status = "checking" | "authenticated" | "unauthenticated";

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    getAuthStatus()
      .then((res) => setStatus(res.authenticated ? "authenticated" : "unauthenticated"))
      .catch(() => setStatus("unauthenticated"));

    function handleExpired() {
      setStatus("unauthenticated");
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
  }, []);

  if (status === "checking") {
    return (
      <div className="login-shell">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <LoginScreen onSuccess={() => setStatus("authenticated")} />;
  }

  return <>{children}</>;
}
