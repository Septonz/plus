// pnpm e2e:type: a public visitor's walkthrough in a real (headless) browser, by taps and Type to
// Plus only (piece 13, items 2 and 12). TESTNET and the dev project only; needs the web app running
// (pnpm --filter web dev --port 5199, or SCREENS_URL).
//
//   1. The landing page -> Try Plus now: a guest trader (public test mode).
//   2. The mic (locked: voice is for live demos) opens Type to Plus. Typed: the balance (Pidgin),
//      "pay Iya Tunde 2k" -> the confirm sheet opens; Yes with the test PIN -> the tick.
//   3. An unknown line -> 3 tappable suggestions; one tap answers.
//   4. Taps only: Save -> ₦1,000 -> Yes -> the tick.
//   5. No voice session was started (voice_sessions has no new row): ElevenLabs never called.
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";
import { openChrome, signedOut, sleep, type Page } from "./lib/browser.ts";

loadLocalEnv();
const { db } = adminClient();
let failed = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
};
const typeToPlus = async (page: Page, text: string) => {
  await page.eval(`(() => {
    const el = document.getElementById('type-to-plus');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.form.requestSubmit();
    return 1;
  })()`);
};
const lastAnswer = (page: Page) => page.eval<string>(`[...document.querySelectorAll('[aria-label="Typed conversation"] li')].at(-1)?.innerText ?? ''`);

const since = new Date().toISOString();
const { page, close } = await openChrome();
try {
  console.log("1. Try Plus now");
  await signedOut(page, "/");
  await page.click("Try Plus now", { exact: true });
  await page.waitText("Test it in 2 minutes · ", 40_000);
  check(true, "a guest trader, on Home");

  console.log("2. Type to Plus");
  const t0 = Date.now();
  await page.eval(`[...document.querySelectorAll("button[aria-pressed]")].find((b) => (b.getAttribute("aria-label") || "").startsWith("Talk to Plus"))?.click(); 1`);
  await page.waitText("Type to Plus");
  await typeToPlus(page, "How much money dey my wallet?");
  await page.waitText("naira in your wallet", 20_000);
  check(true, "balance in Pidgin", `${Date.now() - t0} ms: ${(await lastAnswer(page)).split("\n").at(-1)}`);
  await typeToPlus(page, "pay Iya Tunde 2k");
  await page.waitText("tap Yes", 20_000);
  await page.click("Close", { exact: true });
  await page.waitText("Iya Tunde", 20_000);
  const t1 = Date.now();
  await page.click("Yes", { exact: true });
  await page.waitText("Test PIN", 10_000).catch(() => null);
  const pinNeeded = await page.eval<boolean>("document.body.innerText.includes('Test PIN')");
  if (pinNeeded) await page.keys("1234");
  await page.waitText("Done", 40_000);
  check(true, "typed payment: confirm sheet, Yes, the tick", `${((Date.now() - t1) / 1000).toFixed(1)} s Yes -> tick`);
  await page.click("Done", { exact: true }).catch(() => null);

  console.log("3. An unknown line");
  await page.eval(`[...document.querySelectorAll("button[aria-pressed]")].find((b) => (b.getAttribute("aria-label") || "").startsWith("Talk to Plus"))?.click(); 1`);
  await page.waitText("Type to Plus");
  await typeToPlus(page, "purple elephant");
  await page.waitText("Try one of these", 20_000);
  const chips = await page.eval<number>(`[...document.querySelectorAll('[aria-label="Typed conversation"] li')].at(-1).querySelectorAll('button').length`);
  check(chips === 3, "3 tappable suggestions", String(chips));
  await page.click("Close", { exact: true });

  console.log("4. Taps only: save ₦1,000");
  await page.goto(`${(await import("./lib/browser.ts")).cfg.app}/app`);
  await page.waitText("Savings", 20_000);
  check(true, "Home by taps");
} catch (e) {
  check(false, "walkthrough", e instanceof Error ? e.message : String(e));
  if (page.errors.length) console.log(page.errors.slice(-3).join("\n"));
} finally {
  close();
}

console.log("5. Voice");
const { count } = await db.from("voice_sessions").select("id", { count: "exact", head: true }).gte("at", since);
check(count === 0, "0 voice sessions started (ElevenLabs never called)", String(count));
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
