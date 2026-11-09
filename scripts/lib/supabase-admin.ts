// Service-role Supabase client for local scripts (dev project only).
// The key is read from SUPABASE_SERVICE_ROLE_KEY, or fetched at runtime through the
// Supabase CLI (`supabase projects api-keys`). It stays in memory and is never printed.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DEV_PROJECT_REF = "qoqmnjzfjhpemwleipth";
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Load the root .env.local (gitignored) without overriding variables already set. */
export function loadLocalEnv(): void {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) process.env[k] = v; // explicit env wins
}

type ApiKey = { name: string; type: string; api_key: string };
let cachedKeys: ApiKey[] | undefined;
function apiKeys(ref: string): ApiKey[] {
  if (cachedKeys) return cachedKeys;
  // --reveal returns secret keys in full (otherwise they are masked). Output stays in memory.
  // On Windows npx is a .cmd, which needs a shell; the arguments are fixed strings.
  const cmd = `npx supabase projects api-keys --project-ref ${ref} --reveal -o json`;
  const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  cachedKeys = JSON.parse(out) as ApiKey[];
  return cachedKeys;
}

function serviceKey(ref: string): string {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keys = apiKeys(ref);
  const key = keys.find((k) => k.type === "secret")?.api_key ?? keys.find((k) => k.name === "service_role")?.api_key;
  if (!key) throw new Error("no secret/service_role key found via the Supabase CLI (run `npx supabase login`)");
  return key;
}

export function adminClient(): { db: SupabaseClient; url: string; ref: string } {
  const ref = process.env.SUPABASE_PROJECT_REF ?? DEV_PROJECT_REF;
  if (ref !== DEV_PROJECT_REF) throw new Error(`refusing to run against project ${ref}: dev project only`);
  const url = `https://${ref}.supabase.co`;
  const db = createClient(url, serviceKey(ref), { auth: { persistSession: false, autoRefreshToken: false } });
  return { db, url, ref };
}

/** Public (publishable / anon) key, for signing in as a normal user. */
export function publishableKey(ref: string = process.env.SUPABASE_PROJECT_REF ?? DEV_PROJECT_REF): string {
  if (process.env.VITE_SUPABASE_ANON_KEY) return process.env.VITE_SUPABASE_ANON_KEY;
  const keys = apiKeys(ref);
  const key = keys.find((k) => k.type === "publishable")?.api_key ?? keys.find((k) => k.name === "anon")?.api_key;
  if (!key) throw new Error("no publishable/anon key found");
  return key;
}
