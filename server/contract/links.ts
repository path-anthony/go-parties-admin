// Where the customer-facing contract pages and files live.

export function signingLink(signingToken: string): string {
  const base = process.env.STOREFRONT_URL?.replace(/\/$/, "");
  if (base) return `${base}/sign/${signingToken}`;
  console.warn("[contracts] STOREFRONT_URL is not set; the signing link points at the API instead of a page");
  return `${apiBase()}/api/contracts/${signingToken}`;
}

export function apiBase(req?: { protocol: string; get(name: string): string | undefined }): string {
  const fromEnv = process.env.PUBLIC_API_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (req) return `${req.protocol}://${req.get("host")}`;
  return "";
}

export const pdfLink = (downloadToken: string, req?: Parameters<typeof apiBase>[0]) => `${apiBase(req)}/api/contracts/pdf/${downloadToken}`;
