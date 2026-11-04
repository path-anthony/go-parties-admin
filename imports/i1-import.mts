// Block I1: inventory clean-up import. Reads imports/I1-workbook.json (made
// by workbook-to-json.py) and the production database through the .env
// DATABASE_URL. Two modes:
//   npx tsx imports/i1-import.mts dry-run   writes imports/I1-dry-run.md, changes nothing
//   npx tsx imports/i1-import.mts apply     backup to imports/backup-<ts>.json, then one transaction
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client.js";
import { cancelGigs } from "../server/gigs.js";

const MODE = process.argv[2];
if (MODE !== "dry-run" && MODE !== "apply") throw new Error("usage: i1-import.mts dry-run | apply");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const STANDARD_UNITS = ["per day", "per event", "per hour", "per guest", "each", "per section", "per 10 guests"];
const TEST_PACKAGES = ["Claude Test Sweet 16 Package", "Star Wars Themed Birthday", "Strippers and Poker"];
const CIGAR_PREFIXES = ["Live Cigar Rollers:", "Cigar Bar:", "Mobile Cigar Lounge:", "Bartender Pairings:"];
// Rulings 3 and 4 (2026-11-04): left exactly as they are, noted for the hide-flag follow-up.
const LEAVE_AS_IS: Record<string, string> = {
  cmtrfusm00047s5ujfsv0f1qw: "Cigar Lounge: The Basic Experience (Replace -> Keep, untouched)",
  cmtrfusj00046s5ujnyxyzgiw: "Cigar Lounge: The Lounge Experience (Replace -> Keep, untouched)",
  cmtrfusg70045s5ujm9d1efji: "Mobile Bar and Cigar Lounge: Private Events (Replace -> Keep, untouched)",
  cmtrfusr20048s5ujec75yscc: "Cigar Bar Basic (Delete -> untouched, crewed)",
  cmtrfukdk001gs5uj35zzek7s: "DJs / Bands and Live Music (Delete -> untouched, crewed)",
};
// Ruling 2 (2026-11-04): held test bookings on these two are cancelled first, then the items are deleted.
const CANCEL_THEN_DELETE = new Set(["cmtsycn0j000110quzwez31zf", "cmu2tkaf50000ez9ksp4qs0xd"]);
const plannedCancels = new Set<string>();

type ExistingRow = { row: number; id: string; currentName: string; suggestedName: string | null; currentCategory: string | null; newCategory: string | null; price: number | null; unit: string | null; pricingNote: string | null; qtyProposed: number | null; action: string | null; why: string | null; offer: string | null; qtyOnHand: number | string | null; description: string | null };
type NewRow = { row: number; name: string; category: string | null; price: number | null; unit: string | null; qtyProposed: number | null; pricingNote: string | null; offer: string | null; qtyOnHand: number | string | null; description: string | null };
type AddonRow = { row: number; onItems: string; groupName: string; choose: string | null; required: string | null; options: string | null; status: string | null };
const book = JSON.parse(readFileSync(path.join(HERE, "I1-workbook.json"), "utf8")) as { existing: ExistingRow[]; new: NewRow[]; addonGroups: AddonRow[] };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const isN = (v: unknown) => String(v ?? "").trim().toUpperCase() === "N";
// Ruling 1 (2026-11-04): a 0 on either tab means "no price"; 0 is never written.
const money = (v: unknown) => (v === null || v === undefined || v === "" || Number(v) === 0 ? null : Math.round(Number(v) * 100) / 100);

// ---- what is in the database now ---------------------------------------------------
type DbItem = Awaited<ReturnType<typeof loadItems>>[number];
async function loadItems() {
  return prisma.item.findMany({ include: { units: { include: { _count: { select: { bookings: true } } } }, addonGroups: { include: { addons: true } }, packageItems: { include: { package: { select: { name: true } } } }, _count: { select: { gigs: true, bookingAddons: true } } } });
}
async function quoteRefs(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ id: string; n: bigint }[]>`SELECT i.id, count(q.id) AS n FROM items i JOIN quotes q ON q.cart->'itemIds' ? i.id GROUP BY i.id`;
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

// ---- the plan ----------------------------------------------------------------------
type Op =
  | { kind: "deletePackage"; id: string; name: string }
  | { kind: "updateItem"; id: string; name: string; data: Prisma.ItemUpdateInput; changes: string[] }
  | { kind: "addUnits"; id: string; name: string; count: number; from: number }
  | { kind: "removeUnits"; id: string; name: string; unitIds: string[]; why: string }
  | { kind: "createItem"; row: NewRow; units: number; data: Prisma.ItemCreateInput }
  | { kind: "setSelectMode"; groupId: string; label: string }
  | { kind: "createGroup"; itemName: string; itemId: string | null; group: { name: string; required: boolean; options: { name: string; priceDelta: number }[] } }
  | { kind: "deleteItem"; id: string; name: string; action: string }
  | { kind: "hideItem"; id: string; name: string; action: string; unitIds: string[]; refs: string }
  | { kind: "cancelBooking"; id: string; customerName: string; eventDate: string };

const report = {
  counts: {} as Record<string, number>,
  deletes: [] as string[],
  renames: [] as string[],
  categoryMoves: new Map<string, number>(),
  priceChanges: [] as string[],
  unitChanges: [] as string[],
  unitCountChanges: [] as string[],
  newItems: [] as string[],
  addonChanges: [] as string[],
  alreadyExists: [] as string[],
  notInDb: [] as string[],
  oddities: [] as string[],
  zeroPrices: [] as string[],
  cannotHide: [] as string[],
  cancelled: [] as string[],
};
const bump = (k: string) => (report.counts[k] = (report.counts[k] ?? 0) + 1);

async function plan(): Promise<{ ops: Op[]; items: DbItem[] }> {
  const items = await loadItems();
  const byId = new Map(items.map((i) => [i.id, i]));
  const byName = new Map(items.map((i) => [norm(i.name), i]));
  const quotes = await quoteRefs();
  const packages = await prisma.package.findMany({ select: { id: true, name: true } });
  const allowedCategories = new Set([...book.existing.map((r) => r.newCategory), ...book.new.map((r) => r.category)].filter((c): c is string => !!c).map((c) => c.trim()));
  const ops: Op[] = [];

  // 1. Test packages.
  for (const name of TEST_PACKAGES) {
    const p = packages.find((x) => x.name === name);
    if (p) {
      ops.push({ kind: "deletePackage", id: p.id, name });
      bump("packages deleted");
    } else report.oddities.push(`Test package "${name}" is not in the database.`);
  }
  for (const p of packages) if (!TEST_PACKAGES.includes(p.name)) report.oddities.push(`Package "${p.name}" is left alone (not one of the three test packages).`);
  const testPackageIds = new Set(packages.filter((p) => TEST_PACKAGES.includes(p.name)).map((p) => p.id));

  const referenced = (it: DbItem) => {
    const bits: string[] = [];
    const bookedUnits = it.units.filter((u) => u._count.bookings > 0).length;
    if (bookedUnits) bits.push(`${bookedUnits} booked unit${bookedUnits === 1 ? "" : "s"}`);
    if (it._count.bookingAddons) bits.push(`${it._count.bookingAddons} booking add-on row${it._count.bookingAddons === 1 ? "" : "s"}`);
    if (it._count.gigs) bits.push(`${it._count.gigs} gig${it._count.gigs === 1 ? "" : "s"}`);
    const q = quotes.get(it.id) ?? 0;
    if (q) bits.push(`${q} quote${q === 1 ? "" : "s"}`);
    const pk = it.packageItems.filter((pi) => !testPackageIds.has(pi.packageId));
    if (pk.length) bits.push(`in package ${pk.map((pi) => `"${pi.package.name}"`).join(", ")}`);
    return bits.join(", ");
  };

  // 2. Existing rows: Update and Keep now; Delete and Replace collected for the end.
  const deleteRows: ExistingRow[] = [];
  const renamedTo = new Map<string, string>();
  for (const r of book.existing) {
    const action = (r.action ?? "").trim();
    const it = byId.get(r.id);
    if (!it) {
      report.notInDb.push(`row ${r.row}: ${r.id} "${r.currentName}" (${action || "no action"})`);
      bump("rows not in the database");
      continue;
    }
    bump(`existing: ${action || "blank action"}`);
    if (LEAVE_AS_IS[r.id]) {
      report.cannotHide.push(`${LEAVE_AS_IS[r.id]}: left exactly as it is; needs the hide flag.`);
      bump("left as is by ruling");
      continue;
    }
    if (action === "Delete" || action === "Replace") {
      deleteRows.push(r);
      continue;
    }
    if (action !== "Update" && action !== "Keep") {
      report.oddities.push(`row ${r.row} "${it.name}": action "${action}" is not one of Delete, Replace, Update, Keep; left alone.`);
      continue;
    }
    const data: Prisma.ItemUpdateInput = {};
    const changes: string[] = [];
    const cat = (r.newCategory ?? "").trim();
    if (!cat) report.oddities.push(`row ${r.row} "${it.name}": New category is blank; category left as "${it.category}".`);
    else if (!allowedCategories.has(cat)) report.oddities.push(`row ${r.row} "${it.name}": category "${cat}" is not in the workbook's category columns; left alone.`);
    else if (cat !== it.category) {
      data.category = cat;
      changes.push(`category "${it.category}" -> "${cat}"`);
      const k = `${it.category} -> ${cat}`;
      report.categoryMoves.set(k, (report.categoryMoves.get(k) ?? 0) + 1);
    }
    const newName = (r.suggestedName ?? "").trim();
    if (newName && newName !== it.name) {
      data.name = newName;
      changes.push(`name "${it.name}" -> "${newName}"`);
      report.renames.push(`"${it.name}" -> "${newName}"`);
      renamedTo.set(norm(newName), it.id);
    }
    const price = money(r.price);
    const oldPrice = it.price === null ? null : Number(it.price);
    if (Number(r.price) === 0 && oldPrice === null) report.zeroPrices.push(`${newName || it.name} (row ${r.row}): column H is 0, price stays blank`);
    if (price !== oldPrice) {
      data.price = price;
      changes.push(`price ${oldPrice ?? "blank"} -> ${price ?? "blank"}`);
      report.priceChanges.push(`${newName || it.name}: ${oldPrice ?? "blank"} -> ${price ?? "blank"}`);
    }
    const unit = (r.unit ?? "").trim();
    if (!STANDARD_UNITS.includes(unit)) report.oddities.push(`row ${r.row} "${it.name}": unit "${unit}" is not in the standard list; unit left as "${it.priceUnit ?? "blank"}".`);
    else if (unit !== it.priceUnit) {
      data.priceUnit = unit;
      changes.push(`unit "${it.priceUnit ?? "blank"}" -> "${unit}"`);
      report.unitChanges.push(`${newName || it.name}: "${it.priceUnit ?? "blank"}" -> "${unit}"`);
    }
    const note = (r.pricingNote ?? "").trim();
    if (note) {
      const line = `Import note: ${note}`;
      if (!(it.notes ?? "").includes(line)) {
        data.notes = it.notes ? `${it.notes}\n${line}` : line;
        changes.push("pricing note appended");
      }
    }
    const desc = (r.description ?? "").trim();
    if (desc) {
      if (desc.length > 240) report.oddities.push(`row ${r.row} "${it.name}": description is ${desc.length} characters, over 240; not set.`);
      else if (desc !== it.description) {
        data.description = desc;
        changes.push("description set");
      }
    }
    if (changes.length) ops.push({ kind: "updateItem", id: it.id, name: it.name, data, changes });

    // Units.
    const total = it.units.length;
    const free = it.units.filter((u) => u._count.bookings === 0);
    if (isN(r.offer)) {
      if (total > 0) {
        ops.push({ kind: "removeUnits", id: it.id, name: it.name, unitIds: free.map((u) => u.id), why: "Offer this? = N" });
        report.unitCountChanges.push(`${it.name}: Offer = N, remove ${free.length} of ${total} units${free.length < total ? ` (${total - free.length} booked, cannot remove)` : ""}`);
        bump("items hidden by Offer = N");
      }
    } else if (r.qtyOnHand !== null && r.qtyOnHand !== undefined && String(r.qtyOnHand).trim() !== "") {
      const want = Number(r.qtyOnHand);
      if (!Number.isInteger(want) || want < 0) report.oddities.push(`row ${r.row} "${it.name}": Quantity on hand "${r.qtyOnHand}" is not a whole number; units left alone.`);
      else if (want > total) {
        ops.push({ kind: "addUnits", id: it.id, name: it.name, count: want - total, from: total });
        report.unitCountChanges.push(`${it.name}: units ${total} -> ${want} (add ${want - total})`);
      } else if (want < total) {
        const removable = free.slice(0, total - want);
        ops.push({ kind: "removeUnits", id: it.id, name: it.name, unitIds: removable.map((u) => u.id), why: `Quantity on hand = ${want}` });
        const short = total - want - removable.length;
        report.unitCountChanges.push(`${it.name}: units ${total} -> ${want} (remove ${removable.length}${short ? `; ${short} booked and could not be removed` : ""})`);
      }
    } else if (total === 0) {
      const q = Number(r.qtyProposed ?? 0);
      if (q > 0) {
        ops.push({ kind: "addUnits", id: it.id, name: it.name, count: q, from: 0 });
        report.unitCountChanges.push(`${it.name}: no units -> ${q} (Qty proposed)`);
        bump("unit-less items given units");
      } else report.oddities.push(`row ${r.row} "${it.name}": has no units and Qty proposed is ${q}; stays without units (not bookable).`);
    }
  }

  // 3. New items.
  const createdNames = new Map<string, NewRow>();
  for (const r of book.new) {
    const name = r.name.trim();
    const existing = byName.get(norm(name));
    if (existing) {
      report.alreadyExists.push(`row ${r.row} "${name}" matches "${existing.name}" (${existing.id}); skipped`);
      bump("new items skipped, already exist");
      continue;
    }
    if (renamedTo.has(norm(name))) report.oddities.push(`row ${r.row} "${name}": an existing item is being renamed to this same name; both will exist.`);
    if (createdNames.has(norm(name))) {
      report.oddities.push(`row ${r.row} "${name}": the New items tab lists this name twice; second one skipped.`);
      continue;
    }
    const cat = (r.category ?? "").trim();
    const unit = (r.unit ?? "").trim();
    const problems: string[] = [];
    if (!cat || !allowedCategories.has(cat)) problems.push(`category "${cat}"`);
    if (!STANDARD_UNITS.includes(unit)) problems.push(`unit "${unit}"`);
    if (money(r.price) === null) report.oddities.push(`row ${r.row} "${name}": price is ${r.price ?? "blank"}; created with no price (ruling 1).`);
    if (problems.length) {
      report.oddities.push(`row ${r.row} "${name}": not created, ${problems.join(", ")}.`);
      continue;
    }
    let units = Number(r.qtyProposed ?? 0);
    let unitNote = "";
    if (isN(r.offer)) {
      units = 0;
      unitNote = " (Offer = N, no units)";
    } else if (r.qtyOnHand !== null && r.qtyOnHand !== undefined && String(r.qtyOnHand).trim() !== "") {
      units = Number(r.qtyOnHand);
      unitNote = ` (Quantity on hand ${units})`;
    } else if (units === 0) {
      units = 1;
      unitNote = " (Qty proposed was 0, so 1 unit)";
      bump("new items with Qty proposed 0, given 1 unit");
    }
    const desc = (r.description ?? "").trim();
    if (desc.length > 240) report.oddities.push(`row ${r.row} "${name}": description is over 240 characters; not set.`);
    const data: Prisma.ItemCreateInput = {
      account: { connect: { id: (await prisma.account.findFirstOrThrow()).id } },
      name,
      category: cat,
      price: money(r.price),
      priceUnit: unit,
      notes: r.pricingNote ? `Import note: ${r.pricingNote.trim()}` : null,
      description: desc && desc.length <= 240 ? desc : null,
    };
    ops.push({ kind: "createItem", row: r, units, data });
    createdNames.set(norm(name), r);
    report.newItems.push(`${name} [${cat}] $${money(r.price)} ${unit}, ${units} unit${units === 1 ? "" : "s"}${unitNote}`);
    bump("new items created");
  }

  // 4. Add-on groups.
  for (const a of book.addonGroups) {
    const on = a.onItems.trim();
    const group = a.groupName.trim();
    if ((on === "Snow Cone Station" && group === "Flavors") || (on === "premium cigars for 10" && group === "Cigar Add Ons")) {
      const it = byName.get(norm(on));
      const g = it?.addonGroups.find((x) => x.name === group);
      if (!it || !g) report.oddities.push(`Add-on row ${a.row}: "${on}" / "${group}" not found in the database; nothing changed.`);
      else if (g.selectMode === "many") report.addonChanges.push(`${on} / ${group}: already Any number`);
      else {
        ops.push({ kind: "setSelectMode", groupId: g.id, label: `${on} / ${group}` });
        report.addonChanges.push(`${on} / ${group}: One -> Any number (options unchanged: ${g.addons.map((o) => `${o.name} +$${Number(o.priceDelta)}`).join("; ")})`);
        bump("add-on groups switched to Any number");
      }
      continue;
    }
    if (group === "Light-up color") {
      const targets = book.new.filter((r) => /^dance platform/i.test(r.name.trim()));
      if (targets.length !== 3) report.oddities.push(`Add-on row ${a.row}: expected three Dance Platform items on the New items tab, found ${targets.length}.`);
      for (const t of targets) {
        const existing = byName.get(norm(t.name));
        if (existing?.addonGroups.some((g) => g.name === group)) {
          report.addonChanges.push(`${t.name} / ${group}: already there`);
          continue;
        }
        ops.push({ kind: "createGroup", itemName: t.name.trim(), itemId: existing?.id ?? null, group: { name: group, required: false, options: [{ name: "None", priceDelta: 0 }, { name: "Stationary color", priceDelta: 30 }, { name: "Revolving color", priceDelta: 30 }] } });
        report.addonChanges.push(`${t.name} / ${group}: new, choose one, optional: None +$0; Stationary color +$30; Revolving color +$30`);
        bump("add-on groups created");
      }
      continue;
    }
    if (group === "Cigar count") {
      const targets = book.new.filter((r) => CIGAR_PREFIXES.some((p) => r.name.trim().startsWith(p)));
      if (targets.length !== 12) report.oddities.push(`Add-on row ${a.row}: expected 12 cigar items on the New items tab, found ${targets.length}.`);
      for (const t of targets) {
        const m = /100 cigars is an add-on \(\+\$([\d,]+(?:\.\d+)?)\)/.exec(t.pricingNote ?? "");
        if (!m) {
          report.oddities.push(`"${t.name}": no "100 cigars is an add-on (+$X)" in its note; Cigar count group not created.`);
          continue;
        }
        const delta = Number(m[1].replace(/,/g, ""));
        const existing = byName.get(norm(t.name));
        if (existing?.addonGroups.some((g) => g.name === group)) {
          report.addonChanges.push(`${t.name} / ${group}: already there`);
          continue;
        }
        ops.push({ kind: "createGroup", itemName: t.name.trim(), itemId: existing?.id ?? null, group: { name: group, required: true, options: [{ name: "40 cigars", priceDelta: 0 }, { name: "100 cigars", priceDelta: delta }] } });
        report.addonChanges.push(`${t.name} / ${group}: new, choose one, required: 40 cigars +$0; 100 cigars +$${delta}`);
        bump("add-on groups created");
      }
      continue;
    }
    const why = group === "Bar extra hour" ? "per-guest add-on amounts are not supported (add-ons are flat dollars)" : group === "Choice of one add-on" ? "package-level choices are not supported (add-on groups live on items)" : group === "Surface" ? "the test item is being dropped and Andy has not confirmed it applies to real bouncers" : "not covered by the import rules";
    report.addonChanges.push(`${on} / ${group}: skipped, ${why}`);
    bump("add-on rows skipped");
  }

  // 5. Delete and Replace rows, last.
  for (const r of deleteRows) {
    const it = byId.get(r.id)!;
    const action = (r.action ?? "").trim();
    if (CANCEL_THEN_DELETE.has(it.id)) {
      const bookings = await prisma.booking.findMany({ where: { units: { some: { unit: { itemId: it.id } } } }, select: { id: true, status: true, customerName: true, eventDate: true, retainerPaid: true, _count: { select: { payments: true } } }, orderBy: { eventDate: "asc" } });
      const blocked = bookings.filter((b) => b._count.payments > 0 || b.retainerPaid || b.status !== "Held");
      if (blocked.length) {
        for (const b of blocked) report.oddities.push(`"${it.name}": booking ${b.id} (${b.customerName}, ${b.eventDate.toISOString().slice(0, 10)}, ${b.status}, ${b._count.payments} payment row${b._count.payments === 1 ? "" : "s"}) is not a plain held test booking; NOT cancelled and the item is NOT deleted.`);
        const free = it.units.filter((u) => u._count.bookings === 0).map((u) => u.id);
        ops.push({ kind: "hideItem", id: it.id, name: it.name, action, unitIds: free, refs: referenced(it) });
        report.deletes.push(`${action}: "${it.name}" (${it.id}) kept, a booking on it has a payment or is not Held`);
        bump(`${action}: hidden, referenced`);
        continue;
      }
      let fresh = 0;
      for (const b of bookings) {
        if (plannedCancels.has(b.id)) continue;
        plannedCancels.add(b.id);
        fresh += 1;
        ops.push({ kind: "cancelBooking", id: b.id, customerName: b.customerName, eventDate: b.eventDate.toISOString().slice(0, 10) });
        report.cancelled.push(`${b.id}: "${b.customerName}", ${b.eventDate.toISOString().slice(0, 10)}, was Held, no payments (on ${it.name}${bookings.length !== fresh ? " and the other test item" : ""})`);
      }
      ops.push({ kind: "deleteItem", id: it.id, name: it.name, action });
      report.deletes.push(`${action}: "${it.name}" (${it.id}) deleted after cancelling ${bookings.length} held test booking${bookings.length === 1 ? "" : "s"}; ${it.units.length} unit${it.units.length === 1 ? "" : "s"}, ${it.addonGroups.length} add-on group${it.addonGroups.length === 1 ? "" : "s"}`);
      bump(`${action}: deleted`);
      report.counts["test bookings cancelled"] = (report.counts["test bookings cancelled"] ?? 0) + fresh;
      continue;
    }
    const refs = referenced(it);
    if (refs) {
      const free = it.units.filter((u) => u._count.bookings === 0).map((u) => u.id);
      ops.push({ kind: "hideItem", id: it.id, name: it.name, action, unitIds: free, refs });
      const booked = it.units.length - free.length;
      if (it.skills.length > 0) report.cannotHide.push(`"${it.name}" (${action}): crewed item (skills ${it.skills.join(", ")}), bookable through the crew with or without units; removing units does not hide it.`);
      else if (free.length === 0 && booked > 0) report.cannotHide.push(`"${it.name}" (${action}): all ${booked} unit${booked === 1 ? "" : "s"} carry bookings and cannot be removed, so it stays listed and bookable.`);
      else if (free.length === 0) report.cannotHide.push(`"${it.name}" (${action}): has no units to remove.`);
      report.deletes.push(`${action}: "${it.name}" (${it.id}) HIDDEN, REFERENCED: ${refs}; ${free.length} of ${it.units.length} units removed`);
      bump(`${action}: hidden, referenced`);
    } else {
      ops.push({ kind: "deleteItem", id: it.id, name: it.name, action });
      report.deletes.push(`${action}: "${it.name}" (${it.id}) deleted with ${it.units.length} unit${it.units.length === 1 ? "" : "s"} and ${it.addonGroups.length} add-on group${it.addonGroups.length === 1 ? "" : "s"}`);
      bump(`${action}: deleted`);
    }
  }
  // Sheet rows versus the database.
  const sheetIds = new Set(book.existing.map((r) => r.id));
  for (const it of items) if (!sheetIds.has(it.id)) report.oddities.push(`Database item "${it.name}" (${it.id}, ${it.category}) is not on the Existing items tab; left alone.`);
  return { ops, items };
}

// ---- report --------------------------------------------------------------------------
function writeReport(ops: Op[], file: string, applied: boolean) {
  const section = (title: string, lines: string[]) => [`## ${title}`, "", ...(lines.length ? lines.map((l) => `- ${l}`) : ["- none"]), ""];
  const md = [
    `# Block I1 ${applied ? "apply" : "dry run"}, ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`,
    "",
    applied ? "Applied in one transaction." : "No changes were made. This is what APPLY would do, in this order: delete test packages, Update and Keep rows, New items, Add-on groups, Delete rows, Replace rows.",
    "",
    "## Counts",
    "",
    "| Action | Count |",
    "|---|---|",
    ...Object.entries(report.counts).sort().map(([k, v]) => `| ${k} | ${v} |`),
    `| operations in the transaction | ${ops.length} |`,
    "",
    ...section("Deletes and Replaces (referenced ones are hidden, not deleted)", report.deletes),
    ...section("Renames", report.renames),
    ...section("Category moves", [...report.categoryMoves.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n} item${n === 1 ? "" : "s"}`)),
    ...section("Price changes", report.priceChanges),
    ...section("Unit text changes", report.unitChanges),
    ...section("Unit count changes", report.unitCountChanges),
    ...section("New items", report.newItems),
    ...section("Add-on group changes", report.addonChanges),
    ...section("New items whose name matched an existing item", report.alreadyExists),
    ...section("Rows the sheet has that the database does not", report.notInDb),
    ...section("Price left blank where column H is 0 (ruling 1)", report.zeroPrices),
    ...section("Test bookings cancelled so their items can be deleted (ruling 2)", report.cancelled),
    ...section("Referenced items that removing units does NOT hide", report.cannotHide),
    ...section("Not covered by the rules, or odd", report.oddities),
  ].join("\n");
  writeFileSync(file, md);
  return md;
}

// ---- apply -----------------------------------------------------------------------------
async function backup(stamp: string) {
  const data = {
    takenAt: new Date().toISOString(),
    items: await prisma.item.findMany(),
    units: await prisma.unit.findMany(),
    addonGroups: await prisma.addonGroup.findMany(),
    addons: await prisma.addon.findMany(),
    packages: await prisma.package.findMany(),
    packageItems: await prisma.packageItem.findMany(),
  };
  const file = path.join(HERE, `backup-${stamp}.json`);
  writeFileSync(file, JSON.stringify(data, null, 1));
  return { file, counts: Object.fromEntries(Object.entries(data).filter(([k]) => k !== "takenAt").map(([k, v]) => [k, (v as unknown[]).length])) };
}

async function apply(ops: Op[]) {
  const summary: string[] = [];
  await prisma.$transaction(
    async (tx) => {
      const createdIds = new Map<string, string>();
      const order: Op["kind"][] = ["cancelBooking", "deletePackage", "updateItem", "addUnits", "removeUnits", "createItem", "setSelectMode", "createGroup", "deleteItem", "hideItem"];
      for (const kind of order) {
        for (const op of ops.filter((o) => o.kind === kind)) {
          switch (op.kind) {
            case "cancelBooking": {
              const b = await tx.booking.findUniqueOrThrow({ where: { id: op.id }, select: { status: true, leadId: true, _count: { select: { payments: true } } } });
              if (b.status !== "Held" || b._count.payments > 0) throw new Error(`booking ${op.id} changed since the plan; aborting`);
              await tx.bookingUnit.deleteMany({ where: { bookingId: op.id } });
              await cancelGigs(tx, op.id);
              await tx.booking.update({ where: { id: op.id }, data: { status: "Cancelled" } });
              if (b.leadId) await tx.leadActivity.create({ data: { leadId: b.leadId, text: "Cancelled by the Block I1 inventory import (test booking on a deleted test item)" } });
              break;
            }
            case "deletePackage":
              await tx.package.delete({ where: { id: op.id } });
              break;
            case "updateItem":
              await tx.item.update({ where: { id: op.id }, data: op.data });
              break;
            case "addUnits":
              await tx.unit.createMany({ data: Array.from({ length: op.count }, (_, n) => ({ itemId: op.id, label: `Unit #${op.from + n + 1}`, status: "Available" })) });
              break;
            case "removeUnits":
              if (op.unitIds.length) await tx.unit.deleteMany({ where: { id: { in: op.unitIds }, bookings: { none: {} } } });
              break;
            case "createItem": {
              const created = await tx.item.create({ data: op.data });
              createdIds.set(norm(op.row.name), created.id);
              if (op.units > 0) await tx.unit.createMany({ data: Array.from({ length: op.units }, (_, n) => ({ itemId: created.id, label: `Unit #${n + 1}`, status: "Available" })) });
              break;
            }
            case "setSelectMode":
              await tx.addonGroup.update({ where: { id: op.groupId }, data: { selectMode: "many", maxSelect: null } });
              break;
            case "createGroup": {
              const itemId = op.itemId ?? createdIds.get(norm(op.itemName));
              if (!itemId) throw new Error(`createGroup: item "${op.itemName}" was not created`);
              const position = await tx.addonGroup.count({ where: { itemId } });
              await tx.addonGroup.create({ data: { itemId, name: op.group.name, required: op.group.required, selectMode: "one", position, addons: { create: op.group.options.map((o, i) => ({ name: o.name, priceDelta: o.priceDelta, position: i })) } } });
              break;
            }
            case "deleteItem":
              await tx.item.delete({ where: { id: op.id } });
              break;
            case "hideItem":
              if (op.unitIds.length) await tx.unit.deleteMany({ where: { id: { in: op.unitIds }, bookings: { none: {} } } });
              break;
          }
        }
        summary.push(`${kind}: ${ops.filter((o) => o.kind === kind).length}`);
      }
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
  return summary;
}

async function verify() {
  const lines: string[] = [];
  lines.push(`items: ${await prisma.item.count()}`);
  const blank = await prisma.item.count({ where: { OR: [{ category: "" }] } });
  lines.push(`items with a blank category: ${blank}`);
  const odd = await prisma.item.findMany({ where: { OR: [{ priceUnit: null }, { priceUnit: { notIn: STANDARD_UNITS } }] }, select: { name: true, priceUnit: true } });
  lines.push(`items with a non-standard unit: ${odd.length}${odd.length ? " " + odd.map((o) => `"${o.name}" (${o.priceUnit ?? "blank"})`).join(", ") : ""}`);
  const noUnits = await prisma.item.findMany({ where: { units: { none: {} } }, select: { name: true, skills: true } });
  lines.push(`items with no units: ${noUnits.length}${noUnits.length ? " " + noUnits.map((o) => `"${o.name}"${o.skills.length ? " (crewed)" : ""}`).join(", ") : ""}`);
  const base = process.env.PUBLIC_API_URL ?? "https://go-parties-admin-production.up.railway.app";
  for (const p of ["/api/items/public", "/api/packages/public"]) {
    const r = await fetch(`${base}${p}`);
    const j = (await r.json()) as { categories?: string[]; packages?: unknown[] };
    lines.push(`${p}: ${r.status}${j.categories ? `, categories: ${j.categories.join(", ")}` : ""}${j.packages ? `, packages: ${j.packages.length}` : ""}`);
  }
  return lines;
}

// ---- main ------------------------------------------------------------------------------
try {
  const { ops } = await plan();
  if (MODE === "dry-run") {
    const md = writeReport(ops, path.join(HERE, "I1-dry-run.md"), false);
    console.log(md.split("\n").slice(0, 60).join("\n"));
    console.log(`\n(full report: imports/I1-dry-run.md)`);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const b = await backup(stamp);
    console.log(`backup: ${path.basename(b.file)} ${JSON.stringify(b.counts)}`);
    const summary = await apply(ops);
    console.log(`applied: ${summary.join(", ")}`);
    writeReport(ops, path.join(HERE, "I1-apply.md"), true);
    console.log((await verify()).join("\n"));
  }
} finally {
  await prisma.$disconnect();
}
