import { Router } from "express";
import type { AdminUser } from "../../src/generated/prisma/client.js";
import { getDefaultAccount } from "../account.js";
import { prisma } from "../db.js";
import { UserError, changeRole, inviteUser, listUsers, removeUser, resendInvite, revokeInvite } from "../users.js";

// Settings > Team. Mounted behind requireAuth and requireOwner (index.ts).
const router = Router();

const fail = (res: import("express").Response, err: unknown) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  throw err;
};

router.get("/", async (_req, res) => {
  const account = await getDefaultAccount();
  res.json({ users: await listUsers(account.id) });
});

router.post("/invites", async (req, res) => {
  const account = await getDefaultAccount();
  try {
    res.status(201).json(await inviteUser(account.id, req.body ?? {}));
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/resend-invite", async (req, res) => {
  const account = await getDefaultAccount();
  try {
    res.json({ ok: true, expiresAt: (await resendInvite(account.id, String(req.params.id))).toISOString() });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/:id/revoke-invite", async (req, res) => {
  const account = await getDefaultAccount();
  try {
    await revokeInvite(account.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

router.patch("/:id", async (req, res) => {
  const account = await getDefaultAccount();
  try {
    res.json(await changeRole(account.id, String(req.params.id), req.body?.role));
  } catch (err) {
    fail(res, err);
  }
});

router.delete("/:id", async (req, res) => {
  const account = await getDefaultAccount();
  const me = res.locals.user as AdminUser;
  if (me.id === String(req.params.id)) return res.status(400).json({ error: "You can't remove yourself. Ask another owner." });
  try {
    await removeUser(account.id, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// Who changed what, newest first.
router.get("/audit", async (_req, res) => {
  const account = await getDefaultAccount();
  const rows = await prisma.adminAudit.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "desc" }, take: 100 });
  res.json(rows.map((r) => ({ id: r.id, userName: r.userName, action: r.action, detail: r.detail, createdAt: r.createdAt.toISOString() })));
});

export default router;
