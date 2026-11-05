// Browser end-to-end check of the community dashboard against your own stack (MODE=local, or MODE=tunnel through the public URLs). Optional: not part of `npm test`.
//
//   WITH_VTC=1 npm run up        # once: VTA + VTC in Docker (ports 8100 and 8200)
//   npm run e2e                  # needs a Chromium/Chrome; CHROME=/path/to/browser to choose one
//   npm run e2e -- --shots dir   # also save a screenshot after each step
//
// Needs: Docker (for the stack), Chromium or Chrome (headless, found on PATH or via CHROME), Node 22 (global WebSocket),
// free port 3000 (the page is served by Vite; 3000 is in the local VTA/VTC CORS allow-list). It skips with a message,
// exit 0, when the stack or the browser is missing (REQUIRE_STACK=1 makes that a failure).
// It drives the app identity from .env: if that identity already has a request or membership, it is withdrawn / left first.
// The journey: visit, apply, in review, approve from the CLI (the page must NOT follow until Refresh), member screens,
// edit card, renew, cooldown, forget local hints, leave, re-apply, then return-to-tab refresh.
import "./lib/cli.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { memberIdentity } from "./lib/member.js";
import { TrustTaskError, VtcClient } from "@buildathon/vtc-client";
import { env, vtcUrl } from "./env.js";
import { Browser, findChrome, tmpProfile } from "./lib/cdp.js";
import { skip, sleep, stackProblem } from "./lib/live.js";

const problem = await stackProblem();
if (problem) skip("e2e", problem);
const chrome = findChrome();
if (!chrome) skip("e2e", "no Chromium or Chrome found on PATH. Install one or set CHROME=/path/to/browser.");
if (typeof WebSocket === "undefined") skip("e2e", "Node 22 or newer is needed (global WebSocket).");

const shotsArg = process.argv.indexOf("--shots");
const shots = shotsArg > 0 ? resolve(process.argv[shotsArg + 1]) : process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : undefined;
if (shots) mkdirSync(shots, { recursive: true });
const PORT = 3000;
const BASE = `http://localhost:${PORT}`;
const root = process.cwd();

// --- the app identity, to put the community in a known state before the browser starts ----------------
// The same identity the page and vtc:join apply as (the did:peer:2 in MODE=tunnel), so the reset below finds the right member.
const me = memberIdentity(env("VTA_CREDENTIAL")!);
const vtc = await VtcClient.connect(vtcUrl(), me, undefined, env("VTC_DID"));
async function resetIdentity() {
  try {
    const s = await vtc.joinStatus();
    if (s.status === "approved") await vtc.leaveCommunity({ confirm: true });
    else if (s.status === "pending") await vtc.withdrawJoin({ requestId: s.requestId });
  } catch (e) { if (!(e instanceof TrustTaskError)) throw e; /* notFound: nothing to reset */ }
}
const approveFromCli = () => {
  const r = spawnSync("npm", ["run", "--silent", "vtc:approve"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0 || !/approved /.test(r.stdout)) throw new Error(`vtc:approve failed: ${r.stdout}${r.stderr}`);
};

// --- the page server ---------------------------------------------------------------------------------------
let vite: ChildProcess | undefined;
async function startVite() {
  try { if ((await fetch(BASE)).ok) throw new Error(`port ${PORT} is already serving something: stop it or free the port`); } catch (e) { if ((e as Error).message.includes("already")) throw e; }
  vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: join(root, "templates/community-dashboard"), stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE)).ok) return; } catch { /* not yet */ } await sleep(500); }
  throw new Error("Vite did not start within 60 s");
}
const stopVite = () => { try { if (vite?.pid) process.kill(-vite.pid, "SIGTERM"); } catch { /* gone */ } };

// --- steps --------------------------------------------------------------------------------------------------
const results: { name: string; ok: boolean; note?: string }[] = [];
const profile = tmpProfile();
let b: Browser | undefined;
const badge = () => b!.eval<string>(`document.querySelector('.badge')?.textContent ?? ''`);
/** Screenshot after bringing `into` (a CSS selector) into view, so what the step is about is in the picture. */
const shot = async (n: string, into?: string) => {
  if (!shots) return;
  await b!.eval(`(() => { const el = ${into ? `document.querySelector(${JSON.stringify(into)})` : "null"}; if (el) el.scrollIntoView({ block: 'center' }); else window.scrollTo(0, 0); return true; })()`);
  await sleep(250);
  await b!.screenshot(join(shots, `${n}.png`));
};
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name}`); }
  catch (e) { results.push({ name, ok: false, note: (e as Error).message }); console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); try {
    if (shots && b) await b.screenshot(join(shots, `FAIL-${results.length}.png`));
    if (b) { await b.click(/^Under the hood/); await sleep(300); console.log("        last calls (newest first):\n          " + (await b.eval<string>(`[...document.querySelectorAll('.call-line')].slice(0, 12).map(e => e.innerText.replace(/\\s+/g, ' ')).join('\\n          ')`))); }
  } catch { /* best effort */ }
  throw e; }
}
const expectBadge = async (re: RegExp, ms = 10_000) => { await b!.waitFor(`/${re.source}/.test(document.querySelector('.badge')?.textContent ?? '')`, ms, `badge ${re}`); };

let failed = false;
try {
  console.log(`e2e: browser ${chrome}, page ${BASE}${shots ? `, screenshots in ${shots}` : ""}`);
  await resetIdentity();
  // Visitors, applicants and former members share the anonymous per-address budget (burst 10, then 1 per 5 s). A run right
  // after another would start with it empty, so give it a moment to refill.
  console.log("  (waiting 45 s for the anonymous rate budget to refill)");
  await sleep(45_000);
  await startVite();
  b = await Browser.launch(chrome!, profile.dir);

  await step("visit: a visitor (or a former member) sees how to join, the journey at Apply, and an as-of line", async () => {
    await b!.goto(BASE);
    // A fresh stack gives Visitor; a stack this identity was already a member of (an earlier run) gives Left, then Re-apply.
    await expectBadge(/^(Visitor|Left)$/);
    if (/Left/.test(await badge())) { await b!.click("Re-apply"); await b!.waitText(/Applying again/); }
    await b!.waitText(/How to join/);
    await b!.waitText(/As of \d\d:\d\d:\d\d, from vtc\/join-requests\/status, \d+ ms/);
    if (!(await b!.eval(`document.querySelector('.journey li[aria-current=step]')?.textContent.includes('Apply')`))) throw new Error("journey strip is not at Apply");
    await shot("01-visitor");
  });

  await step("apply: preview first, then sign and send, then In review with a local hint", async () => {
    await b!.click("Apply to join");
    await b!.waitText(/Check before you sign/);
    await shot("02-preview", ".preview");
    await b!.click("Sign and send");
    await expectBadge(/^In review$/);
    await b!.waitText(/Your request was sent/);
    await b!.waitText(/Local hint\./);
    await b!.waitText(/Criterion \(local hint\)/);
    await shot("03-in-review");
  });

  await step("CLI approves in another process: the page does not follow until Refresh", async () => {
    await b!.click("Pause checking"); // so only a refresh, not the poll, can move the page
    approveFromCli();
    await sleep(2500);
    if (!/^In review$/.test(await badge())) throw new Error(`the page changed by itself: ${await badge()}`);
    await b!.click("Refresh status");
    await expectBadge(/^Member$/);
    await b!.waitText(/Membership card/);
    await shot("04-member");
  });

  await step("member screens: card, as-of lines per panel, Community / Directory / My card / Account", async () => {
    await b!.waitText(/from GET \/v1\/member\/me, \d+ ms/);
    await b!.waitText(/from vtc\/community\/profile\/show/);
    await b!.click("Directory"); await b!.waitText(/Other members as the community shows them/); await b!.waitText(/from vtc\/directory\/entries\/list/);
    await shot("05-directory");
    await b!.click("My card"); await b!.waitText(/Your entry in the member directory/); await b!.waitText(/from vtc\/directory\/card\/show/);
    await b!.click("Account"); await b!.waitText(/Renew membership/);
    await b!.click("Community"); await b!.waitText(/Groups/);
  });

  await step("edit card: save changes the community's record, and the page shows what it read back", async () => {
    await b!.click("My card");
    await b!.waitText(/Your entry in the member directory/);
    await b!.click("Edit card");
    const value = `e2e-${Date.now() % 100000}`;
    await b!.fill("form input[type=text]", value);
    await shot("06-edit-card");
    await b!.click("Save");
    await b!.waitText(/Your card was updated/);
    await b!.waitFor(`document.body.innerText.includes(${JSON.stringify(value)})`, 8000, "the saved value after a re-read");
    await shot("07-card-saved");
  });

  await step("renew: toast, then re-read", async () => {
    await b!.click("Account");
    await b!.click("Renew");
    await b!.waitText(/Your membership was renewed/);
    await shot("08-renewed");
  });

  await step("cooldown: Refresh all disables right after use and comes back", async () => {
    await sleep(1200); // let any cooldown from the action re-read lapse
    await b!.click("Refresh all");
    if ((await b!.isDisabled(/^Refresh all$/)) !== true) throw new Error("Refresh all stayed enabled right after a refresh");
    await b!.waitFor(`[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Refresh all')?.disabled === false`, 5000, "Refresh all to re-enable");
  });

  await step("forget local hints: the note and the stored id go away, the page re-reads and stays Member", async () => {
    const key = await b!.eval<string>(`Object.keys(localStorage).find(k => k.startsWith('community-dashboard:')) ?? ''`);
    if (!key) throw new Error("no local hint was stored");
    await shot("09a-local-hint", "[role=note].info");
    await b!.click("Forget local hints");
    await b!.gone(/Local hint\./);
    if (await b!.eval(`localStorage.getItem(${JSON.stringify(key)}) !== null`)) throw new Error("the hint is still in localStorage");
    await sleep(600);
    await expectBadge(/^Member$/);
    await shot("09-hints-forgotten");
  });

  await step("leave: typed word, confirmation, then Left from a fresh read", async () => {
    await b!.click("Account");
    if ((await b!.isDisabled(/^Leave community$/)) !== true) throw new Error("Leave was enabled before typing the word");
    await b!.fill("#leave-confirm", "leave");
    await b!.click("Leave community");
    await b!.waitText(/Last chance/);
    await b!.click(/^Yes, leave community$/i);
    await b!.waitText(/You left the community/);
    await expectBadge(/^Left$/);
    await shot("10-left");
  });

  await step("re-apply: same identity applies again and is In review", async () => {
    // Having left, this identity is anonymous again, and the member portal calls earlier spent that shared budget.
    await sleep(25_000);
    await b!.click("Re-apply");
    await b!.waitText(/Applying again as the same identity/);
    await b!.click("Apply to join");
    await b!.click("Sign and send");
    await expectBadge(/^In review$/);
    await shot("11-reapplied");
  });

  await step("return to the tab: an approval made elsewhere shows up without pressing anything", async () => {
    await b!.click("Pause checking");
    await sleep(15_500); // the last read must be at least 15 s old for a focus refresh to act
    approveFromCli();
    await b!.eval(`document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); true`);
    await expectBadge(/^Member$/, 8000);
    await shot("12-focus-refresh");
  });

  await step("CLI removes the member (vtc:leave): the page follows to Left on Refresh all, not before", async () => {
    await sleep(1500);
    const r = spawnSync("npm", ["run", "--silent", "vtc:leave", "--", "--yes"], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`vtc:leave failed: ${r.stdout}${r.stderr}`);
    await sleep(1500);
    if (!/^Member$/.test(await badge())) throw new Error(`the page changed by itself: ${await badge()}`);
    await b!.click("Refresh all");
    await expectBadge(/^Left$/, 12_000);
    await shot("13-left-from-cli");
  });

  await step("the browser console and network stayed clean", async () => {
    // Refusals and "nothing open" answers are HTTP 4xx by design and the browser logs them as resource errors.
    const real = b!.problems.console.filter((m) => !/Failed to load resource: the server responded with a status of 4\d\d/.test(m));
    const bad = [...real, ...b!.problems.exceptions, ...b!.problems.failedRequests];
    if (bad.length) throw new Error(`${bad.length} console/network problem(s):\n          ${bad.slice(0, 8).join("\n          ")}`);
    const http = b!.problems.httpErrors.filter((l) => !/\/v1\/(trust-tasks|community\/public-profile|member\/)|favicon/.test(l));
    if (http.length) throw new Error(`unexpected HTTP errors: ${http.slice(0, 5).join("; ")}`);
    console.log(`        (${b!.problems.httpErrors.length} expected 4xx answers from the community: refusals and notFound)`);
  });
} catch (e) {
  failed = true;
  // A step prints its own failure; this is for what happens outside one (starting Vite or the browser).
  if (!results.some((r) => !r.ok)) console.error(`e2e: ${(e as Error)?.stack ?? e}`);
} finally {
  try { await b?.close(); } catch { /* closed */ }
  stopVite();
  profile.remove();
  try { await resetIdentity(); } catch { /* the stack may be gone */ }
  if (!shots) rmSync(join(root, "templates/community-dashboard/node_modules/.vite"), { recursive: true, force: true });
}
const passed = results.filter((r) => r.ok).length;
console.log(`\ne2e ${failed ? "FAILED" : "ok"}: ${passed}/${results.length} steps passed${failed ? " (stopped at the first failure)" : ""}`);
process.exit(failed ? 1 : 0);
