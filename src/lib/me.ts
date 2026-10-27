import { createContext, useContext } from "react";
import type { AdminUser } from "./types";

// The signed-in staff member, set by AuthGate once /api/auth/me answers.
// Owner-only pages and controls read the role from here; the server
// enforces it regardless.
export const MeContext = createContext<{ me: AdminUser | null; refresh: () => void }>({ me: null, refresh: () => undefined });
export const useMe = () => useContext(MeContext);
export const useIsOwner = () => useContext(MeContext).me?.role === "Owner";
