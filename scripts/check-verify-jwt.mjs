// pnpm functions:check-jwt (CI): every Edge Function's gateway JWT check (verify_jwt in
// supabase/config.toml) must match the approved list below. `supabase functions deploy` applies
// config.toml, so a wrong value there silently changes production on the next deploy (2026-11-10:
// scheduler and sync-events were flipped to true and pg_cron, which sends no JWT, got 401s).
//
// Every folder in supabase/functions (except _shared) must have a [functions.<name>] section with
// an explicit verify_jwt. Changing this list needs the owner's approval (CLAUDE.md, "Edge Functions").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Approved verify_jwt = false: each checks its own secret or login first (see CLAUDE.md). */
const NO_GATEWAY_JWT = new Set([
  "agent-tools", // her login, an onboarding token, or the voice agent's shared secret
  "scheduler", // pg_cron: x-plus-cron-secret, jobGate first
  "sync-events", // pg_cron: x-plus-cron-secret, jobGate first
  "chain-worker", // pg_cron and the chain_outbox trigger: x-plus-cron-secret, jobGate first
  "agent-api", // the agent's login (Supabase Auth) first
  "helper-api", // the helper's login (Supabase Auth) first
  "voice-session", // her login or a signed onboarding token first
  "payout-sim", // /health: x-plus-cron-secret or x-plus-secret (privateHealth); other routes: her login first (approved 2026-11-10)
]);

const toml = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
const declared = new Map();
for (const m of toml.matchAll(/^\[functions\.([a-z0-9-]+)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
  const v = /^verify_jwt\s*=\s*(true|false)\s*$/m.exec(m[2]);
  declared.set(m[1], v ? v[1] === "true" : null);
}
const functions = readdirSync(join(ROOT, "supabase", "functions"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name).sort();

const problems = [];
for (const fn of functions) {
  const want = !NO_GATEWAY_JWT.has(fn);
  if (!declared.has(fn)) problems.push(`${fn}: no [functions.${fn}] section in supabase/config.toml (expected verify_jwt = ${want})`);
  else if (declared.get(fn) === null) problems.push(`${fn}: no explicit verify_jwt (expected ${want})`);
  else if (declared.get(fn) !== want) problems.push(`${fn}: verify_jwt = ${declared.get(fn)}, approved value is ${want}`);
}
for (const fn of NO_GATEWAY_JWT) if (!functions.includes(fn)) problems.push(`${fn}: approved for verify_jwt = false but has no folder`);

if (problems.length) {
  console.error("verify_jwt does not match the approved list (scripts/check-verify-jwt.mjs):");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("Changing a function's verify_jwt needs the owner's approval; see CLAUDE.md (Edge Functions).");
  process.exit(1);
}
console.log(`verify_jwt matches the approved list for ${functions.length} functions (false: ${[...NO_GATEWAY_JWT].join(", ")}).`);
