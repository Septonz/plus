// pnpm staff:create — one staff demo user for the dashboard (dev project only).
//
//   DEMO_STAFF_EMAIL=you@example.com pnpm staff:create
//
// Creates (or updates) the user with app_metadata.role = "staff", which the RLS read policies
// check. app_metadata can only be set with the service role, so nobody can make themselves staff.
// A new user gets a random password, printed once to YOUR terminal (it is not saved anywhere).
// Set DEMO_STAFF_PASSWORD to choose it yourself, or pass --reset-password for a new random one.
// The script then signs in as that user and reads the users table to prove the policy works.
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { adminClient, loadLocalEnv, publishableKey } from "./lib/supabase-admin.ts";

loadLocalEnv();

async function main() {
  const email = process.env.DEMO_STAFF_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("set DEMO_STAFF_EMAIL, e.g. DEMO_STAFF_EMAIL=you@example.com pnpm staff:create");
  }
  const { db, url } = adminClient();
  const reset = process.argv.includes("--reset-password");

  // Find an existing user by email (demo project: a few pages at most).
  let existing: { id: string } | undefined;
  for (let page = 1; page <= 10 && !existing; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    existing = data.users.find((u) => u.email?.toLowerCase() === email);
    if (data.users.length < 200) break;
  }

  let password: string | undefined = process.env.DEMO_STAFF_PASSWORD;
  if (!existing || reset) password ??= randomBytes(12).toString("base64url");

  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, {
      app_metadata: { role: "staff" },
      ...(password ? { password } : {}),
    });
    if (error) throw error;
    console.log(`Updated ${email}: app_metadata.role = staff${password ? ", password changed" : ""}`);
  } else {
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: "staff" },
    });
    if (error) throw error;
    existing = { id: data.user.id };
    console.log(`Created staff user ${email}`);
  }

  // Prove it: sign in with the public key and read through RLS.
  if (password) {
    const anon = createClient(url, publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await anon.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const { count, error } = await anon.from("users").select("id", { count: "exact", head: true });
    if (error) throw error;
    const { error: credErr, data: creds } = await anon.from("user_credentials").select("user_id").limit(1);
    console.log(`Signed in as staff: can read ${count} users; user_credentials ${credErr || (creds ?? []).length === 0 ? "hidden (as intended)" : "VISIBLE (unexpected!)"}`);
  }

  console.log(`
How to log in
  Project:  ${url}
  Email:    ${email}
  Password: ${password ?? "(unchanged; rerun with --reset-password for a new one)"}

  The web dashboard login is not built yet. Until it is, sign in from code with the
  publishable key: supabase.auth.signInWithPassword({ email, password }); staff can then
  select users, helpers, sim_bank_accounts, transactions, cash_events, remittances, groups,
  group_members, chain_events and payees (read-only), including Realtime on transactions,
  remittances, cash_events and chain_events.
  This password is shown only here. Store it in your password manager.`);
}

main().catch((err) => {
  console.error(`staff:create failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
