import { Router } from "express";
import { getDefaultAccount } from "../account.js";
import { ADDON_GROUPS_INCLUDE, publicAddonGroups } from "../addons.js";
import { prisma } from "../db.js";
import { availabilityLimiter } from "../rateLimit.js";
import { groupsOf } from "../../src/lib/occasions.js";

// Public, no session: the storefront asks for the published packages of
// one occasion (a package offered under several occasions appears under
// each), or, with no occasion (Block A2), for every published package in
// one response. Mounted on /api/packages ahead of the session-gated
// packages router and defines only this path, so everything else there
// still hits the gate. The select is the allowlist of public fields.
const router = Router();

const PUBLIC_SELECT = {
  id: true,
  name: true,
  description: true,
  price: true,
  keywords: true,
  occasions: true,
  photoUrl: true,
  tag: true,
  guestNote: true,
  items: {
    select: {
      quantity: true,
      item: {
        select: {
          id: true,
          name: true,
          category: true,
          price: true,
          priceUnit: true,
          photoUrl: true,
          addonGroups: ADDON_GROUPS_INCLUDE.addonGroups,
        },
      },
    },
    orderBy: { item: { name: "asc" as const } },
  },
} as const;

type Row = Awaited<ReturnType<typeof loadPublished>>[number];

function loadPublished(accountId: string, occasion: string | null) {
  return prisma.package.findMany({
    where: { accountId, status: "Published", ...(occasion ? { occasions: { has: occasion } } : {}) },
    orderBy: [{ price: "asc" }, { name: "asc" }],
    select: PUBLIC_SELECT,
  });
}

// The package as the storefront reads it. `occasion` is the one asked for
// when there was one, else the first group the package belongs to;
// `groups` names every group its sub-occasions fall under ("Kids party",
// "Wedding"), so a caller with no occasion can sort the list.
function publicPackage({ price, items, tag, guestNote, ...pkg }: Row, occasion: string | null) {
  const groups = [...new Set(pkg.occasions.flatMap((o) => groupsOf(o)))];
  return {
    ...pkg,
    occasion: occasion ?? groups[0] ?? pkg.occasions[0] ?? null,
    groups,
    tag: tag ?? null,
    guestNote: guestNote ?? null,
    price: Number(price),
    items: items.map(({ quantity, item }) => ({
      itemId: item.id,
      name: item.name,
      category: item.category,
      price: item.price === null ? null : Number(item.price),
      priceUnit: item.priceUnit,
      // So a cart row that came from a package shows the item's real
      // photo, the same as one added from the catalog.
      photoUrl: item.photoUrl,
      quantity,
      // A package is booked as a cart of these items, so their add-on
      // groups come along the same way they do on the public catalog.
      addonGroups: publicAddonGroups(item.addonGroups),
    })),
  };
}

// The no-occasion answer is the whole catalog of packages; it is kept for
// a minute and dropped whenever a package is written in the admin.
export const ALL_PACKAGES_CACHE_MS = 60_000;
let allCache: { body: unknown; until: number } | null = null;
export function clearPublicPackagesCache() {
  allCache = null;
}

router.get("/public", availabilityLimiter, async (req, res) => {
  const occasion = typeof req.query.occasion === "string" ? req.query.occasion.trim() : "";
  const account = await getDefaultAccount();
  if (!occasion) {
    const now = Date.now();
    if (allCache && allCache.until > now) {
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.json(allCache.body);
    }
    const packages = await loadPublished(account.id, null);
    const body = { occasion: null, packages: packages.map((p) => publicPackage(p, null)) };
    allCache = { body, until: now + ALL_PACKAGES_CACHE_MS };
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.json(body);
  }
  const packages = await loadPublished(account.id, occasion);
  res.json({ occasion, packages: packages.map((p) => publicPackage(p, occasion)) });
});

export default router;
