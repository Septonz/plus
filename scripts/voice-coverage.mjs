// pnpm voice:coverage (plain JS so CI runs it on Node 20): everything she can do by tapping, she can also ask the voice agent to do.
//
// For each market it collects the app's actions from the web source (every read tool, prepare,
// confirm and setting the screens call, and the screen tools registered with useScreenTools), and
// checks that the market's ElevenLabs agent has a tool for each one (agent/ng/tools/*.json for
// Nigeria, agent/tools/*.json for India). It also checks the other way: every webhook tool the agent
// has is served by agent-tools, and every client tool is registered by the app.
// Fails (exit 1) on a gap. A few actions are app-only on purpose; each says why below.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** Keys of an exported object literal (`export const NAME ... = { key: value, ...SPREAD }`), spreads followed. */
function keysOf(file, name, seen = new Set()) {
  const src = read(file);
  const start = src.search(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{`));
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const body = src.slice(src.indexOf("{", start) + 1, src.indexOf("\n};", start));
  const out = new Set();
  for (const m of body.matchAll(/^\s*([a-z_]+)(?::|,\s*$)/gm)) out.add(m[1]); // "key: value" and shorthand "key,"
  for (const m of body.matchAll(/\.\.\.([A-Z_]+)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const where = m[1] === "ASSET_TOOLS" ? "supabase/functions/_shared/tools-assets.ts" : file;
    for (const k of keysOf(where, m[1], seen)) out.add(k);
  }
  return out;
}

function files(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [dir];
  return readdirSync(abs).flatMap((f) => files(join(dir, f))).filter((f) => /\.tsx?$/.test(f));
}

/** Tool names the screens call: tool('x'), run('x'), useTool('x'), call('x'), including both sides of a ternary. */
function calledTools(dirs) {
  const out = new Map();
  for (const f of dirs.flatMap(files)) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:tool|run|useTool|call)(?:<[^>]*>)?\(\s*([^,)]*)/g)) {
      for (const q of m[1].matchAll(/'([a-z][a-z_]+)'/g)) if (!out.has(q[1])) out.set(q[1], f);
    }
  }
  return out;
}

/** Screen tools the app registers for the voice agent (useScreenTools({ name: async ... })). */
function screenTools(file) {
  const src = read(file);
  const start = src.indexOf("useScreenTools(");
  const block = src.slice(start, src.indexOf("\n  })", start));
  return new Set([...block.matchAll(/^\s{4}([a-z_]+): async/gm)].map((m) => m[1]));
}

function agentTools(dir) {
  const out = new Map();
  for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".json"))) {
    const t = JSON.parse(read(join(dir, f))).tool_config;
    out.set(t.name, t.type);
  }
  return out;
}

// Not tools at all: the public front door and sign-in (no agent involved).
const PUBLIC = new Set(["demo_logins", "sign_in", "sample_record", "finish_onboarding", "start_onboarding"]);
// App-only on purpose, with the reason.
const APP_ONLY = {
  set_pin: "the PIN is typed on her screen, never spoken (the agent says so and opens Profile)",
  asset_photo: "the photo upload itself; by voice, take_photo opens the camera and she taps the shutter",
};
// The same action under the agent's own name.
const ALIASES = {
  update_settings: ["set_language", "set_auto_save"],
};

const ngServed = new Set([...keysOf("supabase/functions/_shared/tools-ng.ts", "NG_APP_TOOLS"), ...keysOf("supabase/functions/_shared/onboarding.ts", "OB_TOOLS"), "set_pin"]);
const inServed = new Set([...keysOf("supabase/functions/_shared/tools.ts", "APP_TOOLS"), ...keysOf("supabase/functions/_shared/onboarding.ts", "OB_TOOLS")]);
const ngVoice = new Set([...keysOf("supabase/functions/_shared/tools-ng.ts", "NG_VOICE_TOOLS"), ...keysOf("supabase/functions/_shared/onboarding.ts", "OB_TOOLS")]);
const inVoice = new Set([...keysOf("supabase/functions/_shared/tools.ts", "VOICE_TOOLS"), ...keysOf("supabase/functions/_shared/onboarding.ts", "OB_TOOLS")]);

const MARKETS = [
  { id: "ng", label: "Plus Nigeria", web: ["apps/web/src/ng", "apps/web/src/onboard"], appFile: "apps/web/src/ng/NgApp.tsx", tools: "agent/ng/tools", served: ngServed, voice: ngVoice },
  { id: "in", label: "Plus India", web: ["apps/web/src/plus", "apps/web/src/onboard"], appFile: "apps/web/src/plus/PlusApp.tsx", tools: "agent/tools", served: inServed, voice: inVoice },
];

let gaps = 0;
for (const m of MARKETS) {
  const agent = agentTools(m.tools);
  const screen = screenTools(m.appFile);
  const called = calledTools(m.web);
  const actions = new Map();
  for (const [name, where] of called) if (m.served.has(name) && !PUBLIC.has(name)) actions.set(name, where);
  for (const name of screen) actions.set(name, m.appFile);
  console.log(`\n${m.label}: ${actions.size} app actions, ${agent.size} agent tools`);
  const missing = [];
  for (const [name, where] of [...actions].sort()) {
    if (APP_ONLY[name]) {
      console.log(`  -  ${name}: app only (${APP_ONLY[name]})`);
      continue;
    }
    const want = ALIASES[name] ?? [name];
    if (!want.some((w) => agent.has(w))) missing.push(`${name} (called in ${where}): no agent tool ${want.join(" / ")}`);
  }
  // The other way round: every agent tool must be served (webhook) or registered by the app (client).
  for (const [name, type] of agent) {
    if (type === "webhook" && !m.voice.has(name)) missing.push(`${name}: the agent has it, but agent-tools does not serve it for ${m.id}`);
    if (type === "client" && name !== "what_is_on_screen" && !screen.has(name)) missing.push(`${name}: a client tool the app does not register (useScreenTools in ${m.appFile})`);
  }
  if (missing.length === 0) console.log(`  ✓ every app action has a voice tool, and every voice tool works`);
  for (const x of missing) console.log(`  ✗ ${x}`);
  gaps += missing.length;
}

if (gaps > 0) {
  console.error(`\nvoice coverage: ${gaps} gap(s). Add the tool under agent/*/tools (then pnpm agents:sync), or list it as app-only with a reason.`);
  process.exit(1);
}
console.log("\nvoice coverage: complete.");
