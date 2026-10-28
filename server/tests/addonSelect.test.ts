// Block A3: how many options a customer may pick from an add-on group. The
// rule itself is pure; the rest runs on a throwaway database through the
// real resolver and the public item shape. Every row made here is deleted.
process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { AddonSelectionError, publicAddonGroups, resolveAddons, selectionProblem } from "../addons.js";

if (!/zz_scratch/.test(process.env.DATABASE_URL ?? "")) throw new Error("addonSelect.test.ts runs only against a throwaway database (name containing zz_scratch)");

const ZZ = "ZZTEST";
let accountId = "";
let itemId = "";
const ids: Record<string, string> = {};

test("the rule: one means one; many takes any number, or up to the cap", () => {
  const one = { name: "Flavor", selectMode: "one", maxSelect: null };
  assert.equal(selectionProblem(one, 1, "Snow Cone"), null);
  assert.equal(selectionProblem(one, 2, "Snow Cone"), "Pick one Flavor for Snow Cone, not several.");
  const any = { name: "Toppings", selectMode: "many", maxSelect: null };
  assert.equal(selectionProblem(any, 7, "Snow Cone"), null);
  const capped = { name: "Toppings", selectMode: "many", maxSelect: 3 };
  assert.equal(selectionProblem(capped, 3, "Snow Cone"), null);
  assert.equal(selectionProblem(capped, 4, "Snow Cone"), "Pick up to 3 Toppings for Snow Cone.");
  // An unknown spelling reads as "one", the safe default.
  assert.equal(selectionProblem({ name: "X", selectMode: "whatever", maxSelect: null }, 2, "Y"), "Pick one X for Y, not several.");
});

before(async () => {
  accountId = (await getDefaultAccount()).id;
  const item = await prisma.item.create({
    data: {
      accountId,
      name: `${ZZ} Snow Cone`,
      category: "Food",
      price: 100,
      priceUnit: "per event",
      addonGroups: {
        create: [
          // No selectMode given: the default applies.
          { name: "Flavor", required: true, position: 0, addons: { create: [{ name: "Cherry", priceDelta: 0, position: 0 }, { name: "Peach", priceDelta: 10, position: 1 }] } },
          { name: "Toppings", selectMode: "many", position: 1, addons: { create: [{ name: "Sprinkles", priceDelta: 2.5, position: 0 }, { name: "Gummies", priceDelta: 3, position: 1 }, { name: "Whip", priceDelta: 1.25, position: 2 }] } },
          { name: "Extras", selectMode: "many", maxSelect: 2, position: 2, addons: { create: [{ name: "Cup", priceDelta: 1, position: 0 }, { name: "Spoon", priceDelta: 1, position: 1 }, { name: "Straw", priceDelta: 1, position: 2 }] } },
        ],
      },
    },
    include: { addonGroups: { include: { addons: true }, orderBy: { position: "asc" } } },
  });
  itemId = item.id;
  for (const g of item.addonGroups) for (const a of g.addons) ids[`${g.name}:${a.name}`] = a.id;
});

after(async () => {
  const i = await prisma.item.deleteMany({ where: { id: itemId } });
  const left = await prisma.item.count({ where: { name: { startsWith: ZZ } } });
  console.log(`# cleanup: ${i.count} items (groups and options cascade); remaining ${left}`);
  await prisma.$disconnect();
});

const item = () => [{ id: itemId, name: `${ZZ} Snow Cone` }];
const pick = (...names: string[]) => new Map([[itemId, names.map((n) => ids[n])]]);

test("a group without a mode defaults to one, and the public shape says so", async () => {
  const g = await prisma.addonGroup.findFirstOrThrow({ where: { itemId, name: "Flavor" }, include: { addons: true } });
  assert.equal(g.selectMode, "one");
  assert.equal(g.maxSelect, null);
  const pub = publicAddonGroups([g]);
  assert.equal(pub[0].selectMode, "one");
  assert.equal(pub[0].maxSelect, null);
  await assert.rejects(resolveAddons(item(), pick("Flavor:Cherry", "Flavor:Peach")), (e: unknown) => e instanceof AddonSelectionError && e.message === `Pick one Flavor for ${ZZ} Snow Cone, not several.`);
});

test("many without a limit takes every pick and prices each one", async () => {
  const chosen = await resolveAddons(item(), pick("Flavor:Peach", "Toppings:Sprinkles", "Toppings:Gummies", "Toppings:Whip"));
  assert.deepEqual(chosen.map((c) => c.addonName), ["Peach", "Sprinkles", "Gummies", "Whip"]);
  const total = Math.round(chosen.reduce((s, c) => s + c.priceDelta, 0) * 100) / 100;
  assert.equal(total, 16.75, "10 + 2.50 + 3 + 1.25");
  const pub = publicAddonGroups(await prisma.addonGroup.findMany({ where: { itemId, name: "Toppings" }, include: { addons: true } }));
  assert.deepEqual([pub[0].selectMode, pub[0].maxSelect], ["many", null]);
});

test("many with a limit takes up to the limit and refuses more", async () => {
  const two = await resolveAddons(item(), pick("Flavor:Cherry", "Extras:Cup", "Extras:Spoon"));
  assert.equal(two.filter((c) => c.groupName === "Extras").length, 2);
  await assert.rejects(resolveAddons(item(), pick("Flavor:Cherry", "Extras:Cup", "Extras:Spoon", "Extras:Straw")), (e: unknown) => e instanceof AddonSelectionError && e.reason === "addon-invalid" && e.message === `Pick up to 2 Extras for ${ZZ} Snow Cone.`);
  const pub = publicAddonGroups(await prisma.addonGroup.findMany({ where: { itemId, name: "Extras" }, include: { addons: true } }));
  assert.deepEqual([pub[0].selectMode, pub[0].maxSelect], ["many", 2]);
});

test("a limit on a one group is ignored in the public shape, and a required one group still has to be answered", async () => {
  const g = await prisma.addonGroup.update({ where: { id: (await prisma.addonGroup.findFirstOrThrow({ where: { itemId, name: "Flavor" } })).id }, data: { maxSelect: 5 }, include: { addons: true } });
  assert.equal(publicAddonGroups([g])[0].maxSelect, null);
  await assert.rejects(resolveAddons(item(), pick("Toppings:Whip")), (e: unknown) => e instanceof AddonSelectionError && e.reason === "addon-required");
  // Existing behavior: one pick per one group, priced as before.
  const chosen = await resolveAddons(item(), pick("Flavor:Peach"));
  assert.deepEqual(chosen.map((c) => [c.groupName, c.addonName, c.priceDelta]), [["Flavor", "Peach", 10]]);
});
