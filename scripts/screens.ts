// pnpm screens — phone-size screenshots of every Plus screen, for design review and the PR.
//
// Drives a headless Chrome over the DevTools protocol (Node's built-in WebSocket; nothing to
// install) against the running web app (`pnpm --filter web dev`, or SCREENS_URL). Uses the dev
// project on Stellar testnet: it signs up a fresh test person through the real sign-up (test
// number +234 700 000 0901, re-runnable), and pays ₦300 by code from Funmi. Money is simulated.
//
//   pnpm screens               all screens -> docs/screens/*.png (390 x 844, phone)
//   pnpm screens funmi agent   only some groups: welcome signup newuser funmi agent india
//   pnpm screens --dark …      the same in dark mode (the phone's setting), saved as *-dark.png
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ROOT, loadLocalEnv } from "./lib/supabase-admin.ts";
import { testNin, testPin } from "./lib/onboard.ts";

loadLocalEnv();
const APP = process.env.SCREENS_URL ?? "http://localhost:5199";
const OUT = join(ROOT, "docs", "screens");
const PORT = 9333;
const W = 390;
const H = 844;
const SCALE = 1.5;
const NEW_PHONE = "0700 000 0901";
const DARK = process.argv.includes("--dark");
const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const on = (g: string) => want.length === 0 || want.includes(g);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chromePath(): string {
  const c = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => p && existsSync(p));
  if (!c) throw new Error("Chrome not found: set CHROME_PATH");
  return c;
}

// ---------------------------------------------------------------------------- DevTools protocol

type Msg = { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string };

class Page {
  private id = 0;
  private waiting = new Map<number, (m: Msg) => void>();
  private events: ((m: Msg) => void)[] = [];
  /** Console errors and uncaught exceptions from the page, printed if a run fails. */
  errors: string[] = [];
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.id && this.waiting.has(m.id)) {
        this.waiting.get(m.id)!(m);
        this.waiting.delete(m.id);
      } else if (m.method) {
        const p = (m as { params?: Record<string, any> }).params;
        if (m.method === "Runtime.exceptionThrown") this.errors.push(String(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text).slice(0, 600));
        if (m.method === "Runtime.consoleAPICalled" && p?.type === "error") this.errors.push(p.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" ").slice(0, 600));
        this.events.forEach((f) => f(m));
      }
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result ?? {}))));
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return (r.result as { value: T }).value;
  }
  async goto(url: string) {
    const loaded = new Promise<void>((res) => this.events.push((m) => m.method === "Page.loadEventFired" && res()));
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(600);
  }
  async waitText(text: string, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for "${text}"`);
  }
  /** Click the first visible button or link whose text (or aria-label) contains `text`. */
  async click(text: string, opts: { exact?: boolean; within?: string } = {}) {
    await this.waitClickable(text, opts);
    await sleep(350);
  }
  private async waitClickable(text: string, { exact = false, within = "body" }: { exact?: boolean; within?: string }) {
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      const ok = await this.eval<boolean>(`(() => {
        const t = ${JSON.stringify(text)};
        const els = [...document.querySelector(${JSON.stringify(within)}).querySelectorAll('button, a, [role=tab], [role=radio]')];
        const hit = els.find((el) => {
          if (el.disabled || el.offsetParent === null) return false;
          const s = (el.innerText || '').trim().replace(/\\s+/g, ' ');
          const a = el.getAttribute('aria-label') || '';
          return ${exact} ? (s === t || a === t) : (s.includes(t) || a === t);
        });
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return true;
      })()`);
      if (ok) return;
      await sleep(250);
    }
    throw new Error(`no clickable "${text}"`);
  }
  async keys(digits: string) {
    for (const d of digits) await this.click(d, { exact: true });
  }
  /** Type into the input under the label containing `label` (React-safe). */
  async type(label: string, value: string) {
    const ok = await this.eval<boolean>(`(() => {
      const l = [...document.querySelectorAll('label')].find((x) => x.innerText.includes(${JSON.stringify(label)}));
      const el = l && l.querySelector('input');
      if (!el) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.blur();
      return true;
    })()`);
    if (!ok) throw new Error(`no input labelled "${label}"`);
    await sleep(200);
  }
  async top() {
    await this.eval("window.scrollTo(0, 0)");
    await sleep(250);
  }
  /** The whole screen, top to bottom, at phone width. */
  async shot(name: string) {
    await sleep(500);
    const h = await this.eval<number>("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, innerHeight)");
    // Stretch the viewport to the whole page, so fixed bars (the bottom nav) sit at the bottom.
    const full = Math.min(h, 4000);
    await this.send("Emulation.setDeviceMetricsOverride", { width: W, height: full, deviceScaleFactor: SCALE, mobile: true });
    await sleep(300);
    const r = await this.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: full, scale: 1 } });
    await this.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: true });
    const file = `${name}${DARK ? "-dark" : ""}.png`;
    writeFileSync(join(OUT, file), Buffer.from(String(r.data), "base64"));
    console.log(`  docs/screens/${file}`);
  }
}

async function openChrome(): Promise<{ page: Page; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "plus-screens-"));
  const proc = spawn(chromePath(), [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--hide-scrollbars",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "about:blank",
  ], { stdio: "ignore" });
  let target: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
  }
  if (!target) throw new Error("Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener("open", res));
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: true });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: DARK ? "dark" : "light" }] });
  return { page, close: () => { ws.close(); proc.kill(); } };
}

// ---------------------------------------------------------------------------- sessions

const url = process.env.VITE_SUPABASE_URL!;
const anon = process.env.VITE_SUPABASE_ANON_KEY!;
async function sessionJson(email: string): Promise<string> {
  const sb = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error || !data.session) throw new Error(`demo login ${email}: ${error?.message}`);
  return JSON.stringify(data.session);
}
async function signedIn(page: Page, path: string, key: string, email: string) {
  await page.goto(`${APP}/`);
  await page.eval(`localStorage.clear(); localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(await sessionJson(email))}); 1`);
  await page.goto(`${APP}${path}`);
}
async function signedOut(page: Page, path = "/app") {
  await page.goto(`${APP}/`);
  await page.eval("localStorage.clear(); 1");
  await page.goto(`${APP}${path}`);
}

// ---------------------------------------------------------------------------- the screens

async function main() {
  if (!url || !anon) throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing in .env.local");
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
      await page.click("English / Pidgin");
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
      await page.waitText("Opening your wallet on Stellar");
      await page.shot("22-signup-wallet-opening");
      await page.waitText("Your account is ready", 120_000);
      await sleep(900);
      await page.shot("23-signup-ready");
      await page.click("Go to my wallet");
      await page.waitText("Bola Adeyemi", 30_000);
      await sleep(1500);
      await page.shot("30-newuser-home");
      await page.click("Add money");
      await page.waitText("Account number");
      await page.shot("31-add-money");
      await page.click("Simulate transfer received");
      await page.waitText("arrived", 90_000);
      await page.shot("32-add-money-arrived");
      await page.click("Back");
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
      await page.click("Add money");
      await page.waitText("Account number");
      await page.shot("41-add-money");
      await page.click("Back");
      await page.click("Pay", { exact: true });
      await page.waitText("Who you wan pay?");
      await page.click("Iya Tunde");
      await page.keys("1500");
      await page.top();
      await page.shot("42-pay-saved");
      await page.click("By phone number");
      await page.type("Their phone number", "0803 555 0101");
      await page.type("Their name", "Mama Ngozi");
      await page.keys("300");
      await page.shot("43-pay-phone");
      await page.click("Next");
      await page.waitText("by code");
      await page.shot("44-confirm-pay-code");
      await page.click("Yes", { within: "[role=dialog]" });
      await page.waitText("Text message (simulated");
      await page.waitText("Verified on Stellar", 60_000);
      await page.shot("45-confirm-done-sms");
      await page.click("Save this person");
      await page.waitText("Saved");
      await page.click("Close", { within: "[role=dialog]" });
      await page.click("Ajo", { exact: true });
      await page.waitText("Members");
      await page.shot("46-ajo");
      await page.click("Home", { exact: true });
      await page.click("Advance");
      await page.waitText("No interest");
      await page.shot("47-advance");
      await page.click("Back");
      await page.click("Cash out", { exact: true });
      await page.waitText("How much cash do you need?");
      await page.shot("48-cash-out");
      await page.click("My record", { exact: true });
      await page.waitText("Came in");
      await page.shot("49-record");
      await page.click("Home", { exact: true });
      await page.click("Settings");
      await page.waitText("Level");
      await page.shot("50-settings");
    }

    if (on("agent")) {
      console.log("Mama Bisi (agent page)");
      await signedIn(page, "/agent", "plus-agent-auth", "demo-mamabisi@example.com");
      await page.waitText("Float on Stellar");
      await page.shot("60-agent-cash");
      await page.click("Redeem code");
      await page.shot("61-agent-redeem");
      await page.click("Register");
      await page.waitText("Register a customer");
      await page.shot("62-agent-register");
      await page.click("Start");
      await page.waitText("What should Plus call you?");
      await page.shot("63-agent-register-name");
      await page.click("Stop");
    }

    if (on("india")) {
      console.log("Selvi (India, shared components)");
      await signedIn(page, "/app", "plus-auth", "demo-selvi@example.com");
      await sleep(3000);
      await page.shot("70-india-home");
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
