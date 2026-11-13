// A headless Chrome over the DevTools protocol (Node's built-in WebSocket; nothing to install), for
// pnpm screens and the browser checks (Type to Plus, viewports, the guest walkthrough).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ROOT, adminClient } from "./supabase-admin.ts";

/** Viewport, output folder and app URL; scripts change these before openChrome(). */
export const cfg = {
  app: process.env.SCREENS_URL ?? "http://localhost:5199",
  out: join(ROOT, "docs", "screens"),
  w: 390,
  h: 844,
  scale: 1.5,
  dark: false,
  port: 9333,
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function chromePath(): string {
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

export class Page {
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
  private async waitClickable(text: string, { exact = false, within = "" }: { exact?: boolean; within?: string }) {
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      const ok = await this.eval<boolean>(`(() => {
        const t = ${JSON.stringify(text)};
        // Default scope: the top-most open dialog (sheet or full-screen card), else the page.
        const dialogs = [...document.querySelectorAll('[role=dialog]')];
        const root = ${JSON.stringify(within)} ? document.querySelector(${JSON.stringify(within)}) : (dialogs.at(-1) || document.body);
        const els = [...root.querySelectorAll('button, a, [role=tab], [role=radio]')];
        const hit = els.find((el) => {
          if (el.disabled || el.offsetParent === null || getComputedStyle(el).visibility === 'hidden' || el.closest('[aria-hidden=true]')) return false;
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
    await this.send("Emulation.setDeviceMetricsOverride", { width: cfg.w, height: full, deviceScaleFactor: cfg.scale, mobile: true });
    await sleep(300);
    const r = await this.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: cfg.w, height: full, scale: 1 } });
    await this.send("Emulation.setDeviceMetricsOverride", { width: cfg.w, height: cfg.h, deviceScaleFactor: cfg.scale, mobile: true });
    const file = `${name}${cfg.dark ? "-dark" : ""}.png`;
    writeFileSync(join(cfg.out, file), Buffer.from(String(r.data), "base64"));
    console.log(`  docs/screens/${file}`);
  }
}

export async function openChrome(): Promise<{ page: Page; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "plus-screens-"));
  const proc = spawn(chromePath(), [
    "--headless=new", `--remote-debugging-port=${cfg.port}`, `--user-data-dir=${dir}`, "--no-first-run", "--hide-scrollbars",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "about:blank",
  ], { stdio: "ignore" });
  let target: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${cfg.port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
  }
  if (!target) throw new Error("Chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener("open", res));
  const page = new Page(ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: cfg.w, height: cfg.h, deviceScaleFactor: cfg.scale, mobile: true });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: cfg.dark ? "dark" : "light" }] });
  return { page, close: () => { ws.close(); proc.kill(); } };
}

// ---------------------------------------------------------------------------- sessions

const url = () => process.env.VITE_SUPABASE_URL!;
const anon = () => process.env.VITE_SUPABASE_ANON_KEY!;
export async function sessionJson(email: string): Promise<string> {
  const sb = createClient(url(), anon(), { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error || !data.session) throw new Error(`demo login ${email}: ${error?.message}`);
  return JSON.stringify(data.session);
}
/** The staff user (app_metadata.role = staff), signed in by a one-off magic link: no password used or changed. */
export async function staffSessionJson(): Promise<string> {
  const { db } = adminClient();
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const staff = data.users.find((u) => u.app_metadata?.role === "staff");
  if (!staff?.email) throw new Error("no staff user (pnpm staff:create)");
  const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email: staff.email });
  if (error) throw error;
  const sb = createClient(url(), anon(), { auth: { persistSession: false } });
  const { data: s, error: e } = await sb.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
  if (e || !s.session) throw new Error(`staff sign-in: ${e?.message}`);
  return JSON.stringify(s.session);
}
export async function signedIn(page: Page, path: string, key: string, email: string) {
  await page.goto(`${cfg.app}/`);
  await page.eval(`localStorage.clear(); localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(await sessionJson(email))}); 1`);
  await page.goto(`${cfg.app}${path}`);
}
export async function signedOut(page: Page, path = "/app") {
  await page.goto(`${cfg.app}/`);
  await page.eval("localStorage.clear(); 1");
  await page.goto(`${cfg.app}${path}`);
}

