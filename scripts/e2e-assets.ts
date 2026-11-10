// pnpm e2e:assets: the asset flow end to end through the real Edge Functions (dev project only).
// Nothing here touches Stellar: assets are off-chain.
//
//   1. A test person signs up (test number +2347000000303; each run archives the previous one) and
//      saves Amaka as a payee (run `pnpm demo:reset ng` first: it makes Amaka eligible to witness).
//   2. register_asset: "Sewing machine", ₦120,000 -> registered.
//   3. asset_photo (app only; the voice refusal is a unit test): a live photo -> evidence verified; only the hash is
//      kept in Postgres, the photo is in the private bucket.
//   4. witness_candidates offers Amaka and Mama Bisi; ask_witnesses asks both.
//   5. Amaka sees the request (with a short-lived photo link) and confirms; Mama Bisi confirms
//      on /agent -> community verified.
//   6. request_inspection; Mama Bisi inspects at ₦110,000 -> independently verified.
//   7. The confidence score never reaches the app: not in the tools, not selectable with her login.
//   8. report_asset stolen -> stops counting (confidence 0); found -> under review.
import { createClient } from "@supabase/supabase-js";
import { plusFetch, signUp, testNin, testPin } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const anon = process.env.VITE_SUPABASE_ANON_KEY!;
const PHONE = "+2347000000303";
const call = plusFetch(url);
let failures = 0;
function check(ok: boolean, what: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

async function demoToken(email: string): Promise<string> {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: process.env.VITE_DEMO_LOGIN_PASSWORD! });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return data.session.access_token;
}

/** A small JPEG-shaped file (starts FF D8 FF E0): the bucket only accepts image/jpeg. */
function jpeg(): string {
  const b = new Uint8Array(4000);
  crypto.getRandomValues(b);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], b.length - 2);
  return Buffer.from(b).toString("base64");
}

async function main() {
  console.log("1. Sign-up, and Amaka as a payee");
  const u = await signUp(url, anon, { name: "Asset Test", language: "en", phone: PHONE, pin: testPin(), nin: testNin() });
  const me = (await db.from("users").select("id").eq("wa_phone", PHONE).is("archived_at", null).single()).data as { id: string };
  const amaka = (await db.from("users").select("id, stellar_pub").eq("name", "Amaka").eq("market_id", "ng").eq("demo_login", true).is("archived_at", null).single()).data as
    { id: string; stellar_pub: string };
  await db.from("payees").insert({ user_id: me.id, name: "Amaka", stellar_address: amaka.stellar_pub });
  const tool = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, u.accessToken);
  const [amakaToken, bisiToken] = await Promise.all([demoToken("demo-amaka@example.com"), demoToken("demo-mamabisi@example.com")]);
  const asAmaka = (name: string, body: Record<string, unknown> = {}) => call(`agent-tools/${name}`, body, amakaToken);
  const asBisi = (name: string, body: Record<string, unknown> = {}) => call(`agent-api/${name}`, body, bisiToken);

  console.log("2. Register");
  const r = await tool("register_asset", { type: "machine", description: "Sewing machine", value: "120,000" });
  const asset = r.asset as Record<string, unknown>;
  check(r.ok === true && asset?.level === "registered" && asset?.value_text === "₦120,000", "registered: Sewing machine, ₦120,000", String(r.text).slice(0, 70));
  const id = String(asset.id);

  console.log("3. The live photo");
  const ph = await tool("asset_photo", { asset_id: id, photo: jpeg(), lat: 7.412345, lon: 3.905678 });
  check(ph.ok === true && (ph.asset as Record<string, unknown>)?.level === "evidence_verified", "photo -> evidence verified", String(ph.text).slice(0, 60));
  const row = (await db.from("assets").select("evidence_hash, evidence_lat, evidence_lon, confidence").eq("id", id).single()).data as Record<string, unknown>;
  check(/^[0-9a-f]{64}$/.test(String(row.evidence_hash)) && Number(row.evidence_lat) === 7.41 && Number(row.evidence_lon) === 3.91,
    "Postgres keeps the hash and a place rounded to about 1 km", `${row.evidence_lat}, ${row.evidence_lon}`);
  const { data: files } = await db.storage.from("asset-evidence").list(`${me.id}/${id}`);
  check((files ?? []).length === 1, "the photo is in the private bucket");
  const pub = await fetch(`${url}/storage/v1/object/public/asset-evidence/${me.id}/${id}/${row.evidence_hash}.jpg`);
  check(pub.status >= 400, "not readable publicly", String(pub.status));

  console.log("4. Ask witnesses");
  const c = await tool("witness_candidates");
  const names = ((c.candidates ?? []) as { name: string; eligible: boolean }[]).filter((x) => x.eligible).map((x) => x.name);
  check(names.includes("Amaka") && names.includes("Mama Bisi"), "candidates: Amaka and Mama Bisi", names.join(", "));
  const ask = await tool("ask_witnesses", { asset_id: id, witnesses: "Amaka and Mama Bisi" });
  check(ask.ok === true && (ask.asked as string[])?.length === 2, "asked both", String(ask.text).slice(0, 70));

  console.log("5. Amaka and Mama Bisi confirm");
  const ar = await asAmaka("witness_requests");
  const mine = ((ar.requests ?? []) as Record<string, unknown>[]).find((x) => x.asset_id === id);
  check(!!mine && String(mine.photo_url ?? "").includes("token="), "Amaka sees it, with a signed photo link");
  const photo = mine?.photo_url ? await fetch(String(mine.photo_url)) : null;
  check(photo?.status === 200, "the signed link opens the photo");
  const a1 = await asAmaka("answer_witness", { request_id: mine?.id, confirm: true });
  check(a1.ok === true, "Amaka confirms", String(a1.text));
  const br = await asBisi("asset_requests");
  const bisiReq = ((br.requests ?? []) as Record<string, unknown>[]).find((x) => x.asset_id === id && x.kind === "community");
  check(!!bisiReq, "Mama Bisi sees it on /agent");
  const a2 = await asBisi("asset_answer", { request_id: bisiReq?.id, confirm: true });
  check(a2.ok === true, "Mama Bisi confirms", String(a2.text));
  let lv = await tool("my_assets");
  const level = () => ((lv.assets ?? []) as Record<string, unknown>[]).find((x) => x.id === id);
  check(level()?.level === "community_verified", "community verified", String(level()?.level));

  console.log("6. Inspection");
  const ins = await tool("request_inspection", { asset_id: id });
  check(ins.ok === true, "inspection requested", String(ins.text).slice(0, 60));
  const br2 = await asBisi("asset_requests");
  const insReq = ((br2.requests ?? []) as Record<string, unknown>[]).find((x) => x.asset_id === id && x.kind === "inspection");
  const a3 = await asBisi("asset_answer", { request_id: insReq?.id, confirm: true, value: "110000" });
  check(a3.ok === true, "Mama Bisi inspects at ₦110,000", String(a3.text));
  lv = await tool("my_assets");
  check(level()?.level === "independently_verified" && level()?.value_text === "₦110,000", "independently verified, value ₦110,000");
  const conf = (await db.from("assets").select("confidence").eq("id", id).single()).data as { confidence: number };
  check(conf.confidence === 90, "internal confidence 90 (85 + 5 for an inspected value)", String(conf.confidence));

  console.log("7. The score never reaches her");
  check(!JSON.stringify(lv).includes("confidence"), "not in my_assets");
  const herClient = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { authorization: `Bearer ${u.accessToken}` } } });
  const sel = await herClient.from("assets").select("confidence").eq("id", id);
  check(!!sel.error, "not selectable with her login", sel.error?.message ?? "readable!");
  const wit = await herClient.from("asset_witnesses").select("id");
  check(!!wit.error || (wit.data ?? []).length === 0, "witness rows not readable with her login");

  console.log("8. Stolen, then found");
  const st = await tool("report_asset", { asset_id: id, status: "stolen" });
  const c2 = (await db.from("assets").select("status, confidence").eq("id", id).single()).data as { status: string; confidence: number };
  check(st.ok === true && c2.status === "stolen" && c2.confidence === 0, "stolen: stops counting", `confidence ${c2.confidence}`);
  const fd = await tool("report_asset", { asset_id: id, status: "found" });
  check(fd.ok === true && (fd.asset as Record<string, unknown>)?.status === "under_review", "found: under review until a new photo");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
