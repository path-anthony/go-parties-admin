const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function extraAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isSameOrigin(origin: string, requestHost: string | undefined): boolean {
  if (!requestHost) return false;
  try {
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

// This app always serves its own frontend and API from the same origin, so
// a request whose Origin matches the Host this server is being reached on
// (requestHost, i.e. req.headers.host) is never actually cross-origin —
// even though the browser still sends an Origin header for it (e.g. a
// same-origin fetch POST like /api/auth/login). That case is always
// allowed, unconditionally, before anything else is checked.
//
// Localhost is allowed too, outside production only (a dev convenience).
// Add *other* deployed origins
// (a separate customer-facing app on a different domain) via
// ALLOWED_ORIGINS instead of touching this file.
export function isOriginAllowed(origin: string, requestHost: string | undefined): boolean {
  if (isSameOrigin(origin, requestHost) || extraAllowedOrigins().includes(origin)) return true;
  // In production the allowlist is the allowlist: a page served from someone's
  // own machine does not get credentialed access to customer routes.
  return process.env.NODE_ENV !== "production" && LOCALHOST_ORIGIN.test(origin);
}
