import cors from "cors";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import helmet from "helmet";
import { isOriginAllowed } from "./cors.js";

// Browser-facing protections for the whole API. Three jobs:
//
//  1. Security headers (helmet) with a Content-Security-Policy the admin
//     actually works under.
//  2. CORS. The storefront lives on another origin and calls a short list of
//     public and customer routes with credentials. Those routes, and only
//     those, get the credentialed allowlist. Every other route is the admin's:
//     it is used from its own origin only, so it gets no CORS headers at all and
//     a request carrying a foreign Origin is refused outright.
//  3. State-changing customer routes need a JSON body and an allowed Origin,
//     so a form on another site cannot make a signed-in customer act.

// Routes the storefront (another origin) is meant to call. Matched against the
// path under /api. Customer and booking routes carry the customer cookie, so
// they need the credentialed allowlist; the rest are read by anyone.
const PUBLIC_ROUTES: RegExp[] = [
  /^\/health$/,
  /^\/items\/public(\/|$)/,
  /^\/items\/[^/]+\/availability$/,
  /^\/packages\/public(\/|$)/,
  /^\/settings\/public$/,
  /^\/bookings\/direct$/,
  /^\/leads\/concierge$/,
  /^\/recommend$/,
  /^\/customer(\/|$)/,
  /^\/contracts(\/|$)/,
  /^\/bids(\/|$)/,
];

export function isPublicRoute(pathUnderApi: string): boolean {
  return PUBLIC_ROUTES.some((re) => re.test(pathUnderApi));
}

const publicCors = cors({
  origin(origin, callback) {
    // Handled per request below; this only runs for routes already known to be public.
    callback(null, origin ?? true);
  },
  credentials: true,
});

const isProd = () => process.env.NODE_ENV === "production";

// localhost is a development convenience; production admin routes do not accept it.
function adminOriginOk(origin: string, host: string | undefined): boolean {
  try {
    if (new URL(origin).host === host) return true;
  } catch {
    return false;
  }
  return !isProd() && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export const corsPolicy: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (isPublicRoute(req.path)) {
    if (origin && !isOriginAllowed(origin, req.headers.host)) {
      return res.status(403).json({ error: "Not allowed by CORS" });
    }
    return publicCors(req, res, next);
  }
  // Admin and webhook routes: no CORS headers. A browser request from another
  // origin is refused here; same-origin and server-to-server calls (no Origin
  // header) pass.
  if (origin && !adminOriginOk(origin, req.headers.host)) {
    return res.status(403).json({ error: "Not allowed by CORS" });
  }
  next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// For routes that act on a customer's behalf with their cookie.
export const customerWriteGuard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin, req.headers.host)) {
    return res.status(403).json({ error: "Not allowed from this site.", reason: "bad-origin" });
  }
  // A body, when there is one, has to be JSON. (Bodiless POSTs such as
  // logout and cancel still carry the storefront's JSON content type.)
  const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
  if (hasBody && !req.is("application/json")) {
    return res.status(415).json({ error: "Send application/json.", reason: "bad-content-type" });
  }
  next();
};

// The CSP the admin works under (checked page by page; see GO-LOG):
//  - scripts only from this origin (Vite builds no inline scripts)
//  - styles: this origin, Google Fonts' stylesheet, and inline style
//    attributes (React sets style props)
//  - fonts: Google Fonts' files
//  - images: this origin, data: (uploaded photos are stored inline), blob:,
//    and https (item photos can be https links)
//  - connect: this origin only (the admin calls its own API)
//  - nothing may frame the admin, the admin frames nothing, no plugins,
//    forms post to self (PDFs are served without a CSP; see routes/contracts.ts)
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "connect-src": ["'self'"],
      "frame-src": ["'none'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
    },
  },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: false },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xFrameOptions: { action: "deny" },
  // The storefront calls this API with fetch (CORS decides that); pages and
  // files here may be opened from anywhere, so do not restrict who embeds them.
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
});
