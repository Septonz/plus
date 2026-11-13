// pnpm screens:extra: a few screens pnpm screens doesn't take (piece 13), into docs/screens:
//   90-verify        /verify with Funmi's sample record, read from Stellar
//   93-type-to-plus  the Type to Plus sheet (voice locked) with typed commands and their answers
//   91-confirm-tick  a typed payment's done state with the "Verified on Stellar · N s" tick
//   94-asset         Funmi's stall stock: its verification levels
// Needs the web app running (pnpm --filter web dev --port 5199). Moves ₦500 of testnet money
// (Funmi -> Iya Tunde); run pnpm recording:reset after.
import { loadLocalEnv } from "./lib/supabase-admin.ts";
import { cfg, openChrome, signedIn, signedOut, sleep, type Page } from "./lib/browser.ts";

loadLocalEnv();
const typeToPlus = async (page: Page, text: string, wait: string) => {
  await page.eval(`(() => {
    const el = document.getElementById('type-to-plus');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.form.requestSubmit();
    return 1;
  })()`);
  await page.waitText(wait, 20_000);
};
const mic = (page: Page) => page.eval(`[...document.querySelectorAll("button[aria-pressed]")].find((b) => (b.getAttribute("aria-label") || "").startsWith("Talk to Plus"))?.click(); 1`);

const { page, close } = await openChrome();
const only = process.argv[2];
try {
  if (!only) {
  console.log("/verify");
  await signedOut(page, "/verify");
  await page.click("Try a sample record");
  await sleep(1500);
  if (!(await page.eval<boolean>("document.body.innerText.includes('Verified in')"))) await page.click("Verify", { exact: true });
  await page.waitText("Verified in", 40_000);
  await sleep(1500);
  await page.top();
  await page.shot("90-verify");

  console.log("Type to Plus and the tick");
  await signedIn(page, "/app", "plus-auth", "demo-funmi@example.com");
  await page.waitText("Savings", 30_000);
  await mic(page);
  await page.waitText("Type to Plus");
  await typeToPlus(page, "How much money dey my wallet?", "naira in your wallet");
  await typeToPlus(page, "can I get a loan", "30,000 naira");
  await sleep(800);
  await page.shot("93-type-to-plus");
  await typeToPlus(page, "pay Iya Tunde 500", "CHECK THIS");
  await page.click("Yes", { exact: true });
  await page.waitText("Verified on Stellar", 60_000);
  await sleep(1200);
  await page.shot("91-confirm-tick");
  await page.click("Close", { exact: true }).catch(() => null);
  }
  if (only) await signedIn(page, "/app", "plus-auth", "demo-funmi@example.com");

  console.log("Asset");
  await page.goto(`${cfg.app}/app`);
  await sleep(2500);
  // A payment left waiting by an earlier, interrupted run: No.
  for (let i = 0; i < 3 && (await page.eval<boolean>("document.body.innerText.includes('CHECK THIS')")); i++) {
    await page.click("No", { exact: true }).catch(() => null);
    await page.click("Close", { exact: true }).catch(() => null);
    await sleep(1500);
  }
  await page.waitText("Assets", 30_000);
  await page.click("Assets");
  await page.click("Stall stock (tomatoes)");
  await sleep(1500);
  await page.top();
  await page.shot("94-asset");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  if (page.errors.length) console.error(page.errors.slice(-3).join("\n"));
  await page.shot("zz-extra-failed").catch(() => null);
  process.exitCode = 1;
} finally {
  close();
}
