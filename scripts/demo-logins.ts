// pnpm demo:logins — make sure every named demo login (demo-*@example.com: Funmi, Kemi, Selvi,
// Meena, Mama Bisi, Amaka) uses the shared demo password VITE_DEMO_LOGIN_PASSWORD.
// If .env.local has none, a new random one is generated and appended there (never printed).
// Dev project only. The password ends up in the public web bundle (demo buttons): it only opens
// fictional people on Stellar testnet.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { adminClient, loadLocalEnv, ROOT } from "./lib/supabase-admin.ts";

/** Same list as supabase/functions/_shared/demo.ts. Staff, partner and admin logins are never here. */
const DEMO_EMAILS = ["demo-funmi@example.com", "demo-kemi@example.com", "demo-selvi@example.com", "demo-mamabisi@example.com", "demo-meena@example.com"];

loadLocalEnv();
const { db } = adminClient();

async function main() {
  let pw = process.env.VITE_DEMO_LOGIN_PASSWORD;
  if (!pw) {
    pw = randomBytes(18).toString("base64url");
    appendFileSync(join(ROOT, ".env.local"), `\n# Demo logins (dev project only; pnpm demo:logins)\nVITE_DEMO_LOGIN_PASSWORD=${pw}\n`);
    console.log("wrote a new VITE_DEMO_LOGIN_PASSWORD to .env.local (value not shown)");
  }
  let n = 0;
  for (let page = 1; page < 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) {
      if (!u.app_metadata?.demo && !DEMO_EMAILS.includes(u.email ?? "")) continue;
      // Only the named demo people (demo-*@example.com). Sign-ups on test numbers keep a random
      // password nobody knows; they sign in with phone + PIN.
      const named = DEMO_EMAILS.includes(u.email ?? "");
      const { error: e } = await db.auth.admin.updateUserById(u.id, { password: named ? pw : randomBytes(24).toString("base64url") });
      if (e) throw new Error(`${u.email}: ${e.message}`);
      if (!named) continue;
      // Flag their rows, so the backend applies the switch and the rate limit to them.
      await db.from("users").update({ demo_login: true }).eq("auth_user_id", u.id);
      await db.from("helpers").update({ demo_login: true }).eq("auth_user_id", u.id);
      console.log(`  ✓ ${u.email}`);
      n++;
    }
    if (data.users.length < 200) break;
  }
  console.log(`${n} demo logins use the demo password.`);
}

main().catch((err) => {
  console.error(`demo:logins failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
