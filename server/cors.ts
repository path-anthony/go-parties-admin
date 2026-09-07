const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function extraAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// Localhost is always allowed (dev convenience — the real access boundary is
// the session cookie, not CORS). Add deployed origins via ALLOWED_ORIGINS
// (comma-separated) instead of touching this file.
export function isOriginAllowed(origin: string): boolean {
  return LOCALHOST_ORIGIN.test(origin) || extraAllowedOrigins().includes(origin);
}
