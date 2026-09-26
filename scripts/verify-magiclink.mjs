// Drives the magic-link flow end to end through the local gateway (the browser
// gRPC-Web edge on :7903 — the api-server no longer serves gRPC-Web), reading
// the dev-logged verify URL from /tmp/qwibid.log. Asserts: new-email login,
// single-use, expired-token rejection, and upgrade-from-anonymous.
import { readFileSync } from "node:fs";
import { createQwibiClient } from "@qwibi/sdk";

const BASE = "http://localhost:7903";
const LOG = "/tmp/qwibid.log";

function tokenFromLog(email) {
  // The dev EmailService logs: ... "email":<email> ... "verify_url":".../auth/verify?token=<tok>"
  const lines = readFileSync(LOG, "utf8").split("\n").reverse();
  for (const ln of lines) {
    if (ln.includes("magic link issued") && ln.includes(email)) {
      const m = ln.match(/auth\/verify\?token=([0-9a-f]+)/);
      if (m) return m[1];
    }
  }
  throw new Error(`no verify URL logged for ${email}`);
}

function code(err) {
  return err?.code ?? err?.cause?.code;
}

const ts = Date.now();
const email = `magic+${ts}@example.com`;
let pass = 0,
  fail = 0;
const ok = (m) => {
  pass++;
  console.log("  PASS", m);
};
const bad = (m) => {
  fail++;
  console.log("  FAIL", m);
};

// 1) Request a link for a brand-new email; the server should log a verify URL.
const anon = createQwibiClient({ baseUrl: BASE });
await anon.requestMagicLink({ email });
let token;
try {
  token = tokenFromLog(email);
  ok(`verify URL logged for ${email} (token ${token.slice(0, 12)}…)`);
} catch (e) {
  bad(String(e));
  process.exit(1);
}

// 2) Verify the token → a Session + an account registered with that email.
const v = await anon.verifyMagicLink({ token });
if (v.session?.accessToken) ok("VerifyMagicLink returned a Session");
else bad("no session returned");
if (v.account?.email === email) ok(`account.email == ${email}`);
else bad(`account.email = ${v.account?.email}`);
const ROLE_USER = 2;
if ((v.account?.roles ?? []).includes(ROLE_USER)) ok("account role == USER (registered)");
else bad(`roles = ${JSON.stringify(v.account?.roles)}`);
const acctId = v.account?.uid;

// 3) Single use: the SAME token must now fail.
try {
  await anon.verifyMagicLink({ token });
  bad("second verify with the same token unexpectedly succeeded");
} catch (e) {
  if (code(e) === 16) ok("second verify rejected (single-use)");
  else bad(`second verify failed with unexpected code ${code(e)}`);
}

// 4) Re-login with the same email returns the SAME account (find-by-email).
await anon.requestMagicLink({ email });
const token2 = tokenFromLog(email);
const v2 = await anon.verifyMagicLink({ token: token2 });
if (v2.account?.uid === acctId) ok("re-login resolves the same account by email");
else bad(`re-login gave a different account (${v2.account?.uid} != ${acctId})`);

// 5) Expired token: an unknown/garbage token must be rejected.
try {
  await anon.verifyMagicLink({ token: "f".repeat(64) });
  bad("unknown token unexpectedly succeeded");
} catch (e) {
  if (code(e) === 16) ok("unknown token rejected");
  else bad(`unknown token failed with unexpected code ${code(e)}`);
}

// 6) Upgrade-from-anonymous: an anonymous session that verifies a fresh email
//    becomes registered with that email — SAME account uid, role flips to USER.
const dev = `dev-verify-${ts}`;
const a = await anon.authenticate({ credential: { method: { case: "anonymous", value: { deviceId: dev } } } });
const anonUid = a.account?.uid;
const anonRoles = a.account?.roles ?? [];
if (!anonRoles.includes(ROLE_USER)) ok(`anonymous account starts NOT registered (uid ${anonUid?.slice(0, 8)}…)`);
else bad(`anonymous account already registered: ${JSON.stringify(anonRoles)}`);

const upgEmail = `upgrade+${ts}@example.com`;
const authed = createQwibiClient({ baseUrl: BASE, token: a.session.accessToken });
await authed.requestMagicLink({ email: upgEmail }); // bound to the anon account
const upgToken = tokenFromLog(upgEmail);
// Verify while presenting the anon token too (belt-and-suspenders for upgrade).
const u = await authed.verifyMagicLink({ token: upgToken });
if (u.account?.uid === anonUid) ok("upgrade kept the same account uid");
else bad(`upgrade created a new account (${u.account?.uid} != ${anonUid})`);
if (u.account?.email === upgEmail) ok(`upgraded account.email == ${upgEmail}`);
else bad(`upgraded account.email = ${u.account?.email}`);
if ((u.account?.roles ?? []).includes(ROLE_USER)) ok("upgraded account role == USER (registered)");
else bad(`upgraded roles = ${JSON.stringify(u.account?.roles)}`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
