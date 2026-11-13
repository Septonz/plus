// pnpm screens — phone-size screenshots of every Plus screen, for design review and the PR.
//
// Drives a headless Chrome over the DevTools protocol (Node's built-in WebSocket; nothing to
// install) against the running web app (`pnpm --filter web dev`, or SCREENS_URL). Uses the dev
// project on Stellar testnet: it signs up a fresh test person through the real sign-up (test
// number +234 700 000 0901, re-runnable), and pays ₦300 by code from Funmi. Money is simulated.
//
//   pnpm screens               all screens -> docs/screens/*.png (390 x 844, phone)
//   pnpm screens funmi agent   only some groups: guest welcome signup newuser funmi agent india
//   pnpm screens --dark …      the same in dark mode (the phone's setting), saved as *-dark.png
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalEnv } from "./lib/supabase-admin.ts";
import { testNin, testPin } from "./lib/onboard.ts";
import { cfg, openChrome, signedIn, signedOut, sleep, staffSessionJson } from "./lib/browser.ts";
loadLocalEnv();
const NEW_PHONE = "0700 000 0901";
const DARK = process.argv.includes("--dark");
cfg.dark = DARK;
const APP = cfg.app;
const OUT = cfg.out;
const { w: W, h: H, scale: SCALE } = cfg;
const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const on = (g: string) => want.length === 0 || want.includes(g);

// ---------------------------------------------------------------------------- the screens

async function main() {
  if (!process.env.VITE_SUPABASE_URL || !process.env.VITE_SUPABASE_ANON_KEY) throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing in .env.local");
  if (!(await fetch(APP).then((r) => r.ok).catch(() => false))) throw new Error(`the web app is not running at ${APP} (pnpm --filter web dev --port 5199)`);
  mkdirSync(OUT, { recursive: true });
  const { page, close } = await openChrome();
  try {
    if (want.includes("peek")) {
      // Quick look while designing: Funmi's and Selvi's home only (not in the default run).
      await signedIn(page, "/app", "plus-auth", "demo-funmi@example.com");
      await page.waitText("Funmi");
      await sleep(2500);
      await page.shot("zz-peek-funmi");
      await signedIn(page, "/app", "plus-auth", "demo-selvi@example.com");
      await sleep(3000);
      await page.shot("zz-peek-selvi");
      return;
    }

    if (on("guest")) {
      // Piece 12: the landing page and a guest trader (public test mode), then a guest agent.
      console.log("Public test mode");
      await signedOut(page, "/");
      await page.waitText("Test it in 2 minutes");
      await page.shot("00-landing");
      await page.click("Try Plus now", { exact: true });
      await page.waitText("Test it in 2 minutes · ", 30_000);
      await sleep(2500);
      await page.top();
      await page.shot("60-guest-home");
      await signedOut(page, "/");
      await page.waitText("Try the agent app");
      await page.click("Try the agent app");
      await page.waitText("Test agent", 30_000);
      await sleep(1500);
      await page.shot("61-guest-agent");
    }

    if (on("welcome")) {
      console.log("Front door");
      await signedOut(page);
      await page.waitText("Open a Plus account");
      await page.shot("01-welcome");
      await page.click("I have an account");
      await page.type("Your phone number", "0700 000 0201");
      await page.keys("2580");
      await page.shot("02-sign-in");
    }

    if (on("signup") || on("newuser")) {
      console.log("Sign-up (real, on test number " + NEW_PHONE + ")");
      await signedOut(page);
      await page.click("Open a Plus account");
      await page.waitText("Country");
      await page.shot("10-signup-intro");
      await page.click("Open a Plus account", { within: "section" });
      await page.waitText("What should Plus call you?");
      await page.type("Your name", "Bola Adeyemi");
      await page.shot("11-signup-name");
      await page.click("Next");
      await page.waitText("Which language do you like?");
      await page.shot("12-signup-language");
      await page.click("English");
      await page.waitText("Your phone number");
      await page.type("Phone number", NEW_PHONE);
      await page.shot("13-signup-phone");
      await page.click("Send me a code");
      await page.waitText("Text message (simulated");
      const code = await page.eval<string>("(document.querySelector('blockquote').innerText.match(/\\b(\\d{6})\\b/) || [])[1]");
      await page.keys(code.slice(0, 5));
      await page.top();
      await page.shot("14-signup-code");
      await page.keys(code.slice(5));
      await page.waitText("Choose a PIN");
      const pin = testPin();
      await page.keys(pin.slice(0, 3));
      await page.shot("15-signup-pin");
      await page.keys(pin.slice(3));
      await page.click("Next");
      await page.keys(pin);
      await page.click("Save my PIN");
      await page.waitText("A quick photo");
      await page.shot("16-signup-photo");
      await page.click("Open the camera");
      await sleep(1500);
      await page.shot("17-signup-camera");
      await page.click("Take the photo");
      await page.waitText("Add your NIN");
      await page.keys("00000000000");
      await page.click("Check my NIN");
      await page.waitText("did not find");
      await page.top();
      await page.shot("18-signup-nin-wrong");
      await page.keys(testNin());
      await page.top();
      await page.shot("19-signup-nin");
      await page.click("Check my NIN");
      await page.waitText("Someone you trust");
      await page.type("Their name", "Tunde");
      await page.type("Their phone", "0803 555 0199");
      await page.shot("20-signup-trusted");
      await page.click("Save");
      await page.waitText("Open my wallet");
      await page.shot("21-signup-wallet");
      await page.click("Open my wallet");
      await page.waitText("Opening your wallet");
      await page.shot("22-signup-wallet-opening");
      await page.waitText("Your account is ready", 120_000);
      await sleep(900);
      await page.shot("23-signup-ready");
      await page.click("Go to my wallet");
      await page.waitText("Bola Adeyemi", 30_000);
      await sleep(1500);
      await page.shot("30-newuser-home");
      await page.click("Your wallet");
      await page.click("Add", { exact: true });
      await page.waitText("Account number");
      await page.shot("31-add-money");
      await page.click("Simulate transfer received");
      await page.waitText("arrived", 90_000);
      await page.shot("32-add-money-arrived");
      await page.click("Close", { exact: true });
      await page.click("Pay", { exact: true });
      await page.waitText("Their phone number");
      await page.shot("33-pay-new-user");
      await page.click("Saved people");
      await page.waitText("No saved people yet");
      await page.shot("34-pay-empty");
      console.log(`  (test PIN for ${NEW_PHONE}: ${pin})`);
    }

    if (on("funmi")) {
      console.log("Funmi");
      await signedIn(page, "/app", "plus-auth", "demo-funmi@example.com");
      await page.waitText("Funmi");
      await sleep(2500);
      await page.shot("40-home");
      await page.click("Your wallet");
      await page.waitText("Available");
      await page.shot("41-wallet");
      await page.click("Add", { exact: true });
      await page.waitText("Account number");
      await page.shot("42-add-money");
      await page.click("Close", { exact: true });
      await page.click("Pay", { exact: true });
      await page.waitText("Iya Tunde");
      await page.click("My code");
      await page.waitText("My pay code");
      await sleep(600);
      await page.shot("42a-my-code");
      await page.click("Close", { exact: true });
      await page.click("Scan");
      await page.waitText("pay code");
      await sleep(600);
      await page.shot("42b-scan");
      await page.click("Close", { exact: true });
      await page.click("Iya Tunde");
      await page.keys("1500");
      await page.top();
      await page.shot("43-pay-saved");
      await page.click("By phone", { exact: true });
      await page.type("Their phone number", "0803 555 0101");
      await page.type("Their name", "Mama Ngozi");
      await page.keys("300");
      await page.shot("44-pay-phone");
      await page.click("Next");
      await page.waitText("by code");
      await page.shot("45-confirm-pay-code");
      await page.click("Yes", { within: "[role=dialog]" });
      await page.waitText("Text message");
      await page.waitText("Verified on Stellar", 60_000);
      await page.shot("46-confirm-done-sms");
      await page.click("Save this person");
      await page.waitText("Saved");
      await page.click("Close", { within: "[role=dialog]" });
      await page.click("Home", { exact: true });
      await page.click("Savings");
      await page.waitText("Stall shade");
      await sleep(600);
      await page.shot("48-savings");
      await page.click("Close", { exact: true });
      await page.click("Loan");
      await page.waitText("You receive");
      await sleep(600);
      await page.shot("48a-loan");
      await page.click("Close", { exact: true });
      await page.click("Your wallet");
      await page.click("Cash out");
      await page.waitText("How much cash do you need?");
      await page.shot("49-cash-out");
      await page.click("Close", { exact: true });
      await page.click("Activity", { exact: true });
      await page.waitText("Came in");
      await page.shot("50-activity");
      await page.click("Profile", { exact: true });
      await page.waitText("Level");
      await page.shot("51-profile");
      await page.click("Home", { exact: true });
      // The voice sheet: a real conversation (Chrome's fake microphone); the agent greets first.
      const mic = `document.querySelector('button[aria-label^="Talk to Plus"], button[aria-pressed="true"]').click(); 1`;
      await page.eval(mic);
      await page.waitText("Wetin I fit do", 30_000).catch(() => undefined);
      await sleep(1500);
      await page.shot("52-voice");
      await page.eval(mic).catch(() => undefined);
    }

    if (on("agent")) {
      console.log("Mama Bisi (agent page)");
      await signedIn(page, "/agent", "plus-agent-auth", "demo-mamabisi@example.com");
      await page.waitText("Left today");
      await page.shot("60-agent-cash");
      await page.click("Code");
      await page.shot("61-agent-redeem");
      await page.click("Register");
      await page.waitText("Register a customer");
      await page.shot("62-agent-register");
      await page.click("Start");
      await page.waitText("What should Plus call you?");
      await page.shot("63-agent-register-name");
      await page.click("Stop");
    }

    if (on("demo")) {
      console.log("/demo (staff projector view, 1440 x 900)");
      await page.goto(`${APP}/`);
      // Without a staff user (pnpm staff:create), this shows the staff sign-in.
      const staff = await staffSessionJson().catch((e) => (console.log(`  (${e.message}: showing the sign-in)`), null));
      await page.eval(staff ? `localStorage.clear(); localStorage.setItem("plus-demo-auth", ${JSON.stringify(staff)}); 1` : "localStorage.clear(); 1");
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.goto(`${APP}/demo`);
      await sleep(9000);
      const r = await page.send("Page.captureScreenshot", { format: "png" });
      const file = `80-demo${DARK ? "-dark" : ""}.png`;
      writeFileSync(join(OUT, file), Buffer.from(String(r.data), "base64"));
      console.log(`  docs/screens/${file}`);
      await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: true });
    }

    if (on("india")) {
      console.log("Selvi (India, shared components)");
      await signedIn(page, "/app", "plus-auth", "demo-selvi@example.com");
      await page.waitText("Recent activity");
      await sleep(2500);
      await page.shot("70-india-home");
      for (const [pass, name] of [["To spend", "72-india-add-money"], ["Savings", "73-india-savings"], ["Advance", "75-india-advance"]]) {
        await page.click(pass);
        await sleep(900);
        await page.shot(name);
        await page.click("Close", { exact: true });
      }
      for (const [tab, name] of [["Pay", "76-india-pay"], ["Activity", "77-india-activity"], ["Profile", "78-india-profile"]]) {
        await page.click(tab, { exact: true });
        await sleep(1500);
        await page.shot(name);
      }
      await signedOut(page);
      await page.click("Open a Plus account");
      await page.click("India");
      await page.shot("71-india-signup-intro");
    }
  } catch (err) {
    await page.shot("zz-failed").catch(() => undefined); // what the screen showed when it stopped
    if (page.errors.length) console.error(`page errors:\n  ${page.errors.slice(-5).join("\n  ")}`);
    throw err;
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(`screens failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
