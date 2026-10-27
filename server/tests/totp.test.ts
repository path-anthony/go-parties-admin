// Pure: the one-time password code against RFC 6238's own test vectors
// (the six-digit tail of its eight-digit SHA1 results), base32, the
// verify window and the backup code shapes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { base32Decode, base32Encode, hotp, newBackupCodes, newSecret, normalizeBackupCode, otpauthUrl, totp, verifyTotp } from "../totp.js";

const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

test("base32 round-trips and matches the RFC secret", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(RFC_SECRET).toString(), "12345678901234567890");
  for (const n of [1, 5, 10, 20, 33]) {
    const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 256));
    assert.deepEqual(base32Decode(base32Encode(buf)), buf, `${n} bytes`);
  }
  assert.equal(base32Decode("gezd gnbv-gy3t").toString(), base32Decode("GEZDGNBVGY3T").toString(), "spaces, dashes and case are ignored");
});

test("the RFC 6238 vectors", () => {
  const cases: [number, string][] = [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ];
  for (const [t, code] of cases) assert.equal(totp(RFC_SECRET, t * 1000), code, `T=${t}`);
  assert.equal(hotp(RFC_SECRET, 1), "287082");
});

test("verify accepts the current step and one either side, nothing else, and only six digits", () => {
  const at = 1234567890 * 1000;
  assert.equal(verifyTotp(RFC_SECRET, "005924", at), true);
  assert.equal(verifyTotp(RFC_SECRET, "005 924", at), true, "a space is fine");
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at - 30_000), at), true, "previous step");
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at + 30_000), at), true, "next step");
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at + 61_000), at), false, "two steps on");
  assert.equal(verifyTotp(RFC_SECRET, "00592", at), false);
  assert.equal(verifyTotp(RFC_SECRET, "0059244", at), false);
  assert.equal(verifyTotp(RFC_SECRET, "", at), false);
});

test("a new secret is 32 base32 characters and the otpauth url carries the issuer and label", () => {
  const s = newSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.notEqual(s, newSecret());
  const u = new URL(otpauthUrl(s, "mel@example.com", "GO Event Group"));
  assert.equal(u.protocol, "otpauth:");
  assert.equal(u.host, "totp");
  assert.equal(decodeURIComponent(u.pathname), "/GO Event Group:mel@example.com");
  assert.equal(u.searchParams.get("secret"), s);
  assert.equal(u.searchParams.get("issuer"), "GO Event Group");
  assert.equal(u.searchParams.get("digits"), "6");
});

test("backup codes: eight, distinct, xxxx-xxxx with no look-alike characters; normalize strips the dash", () => {
  const codes = newBackupCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
  assert.equal(normalizeBackupCode(" AB2c-D3ef "), "ab2cd3ef");
});
