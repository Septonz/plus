import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Asset, approx, matchAsset, nextStep, parseAssetType, statusChange, valueMinor } from "./assets.ts";
import type { AssetStore, Candidate, Who } from "./assets.ts";
import { ASSET_TOOLS } from "./tools-assets.ts";
import type { NgContext } from "./tools-ng.ts";
import type { User } from "./tools.ts";

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: "a1", user_id: "u1", type: "stock", description: "Stall stock (tomatoes)", estimated_value: 9_000_000n, level: "registered",
  status: "active", evidence_at: null, inspected_at: null, created_at: "2026-11-10T00:00:00Z",
  witnesses_confirmed: 0, witnesses_waiting: 0, inspection_waiting: false, pledged: false, ...over,
});

Deno.test("parseAssetType: names and the words she uses", () => {
  assertEquals(parseAssetType("stock"), "stock");
  assertEquals(parseAssetType("my okada"), "motorcycle");
  assertEquals(parseAssetType("two goats"), "livestock");
  assertEquals(parseAssetType("grinding machine"), "machine");
  assertEquals(parseAssetType("generator"), "machine");
  assertEquals(parseAssetType("barber clippers"), "tools");
  assertEquals(parseAssetType("tomatoes"), "stock");
  assertEquals(parseAssetType("a house"), null);
});

Deno.test("matchAsset: by what she calls it, one open asset by default, ambiguity gives options", () => {
  const stock = asset();
  const gen = asset({ id: "a2", type: "machine", description: "Generator" });
  const old = asset({ id: "a3", description: "Old stock", status: "released" });
  assertEquals(matchAsset([stock], "").match?.id, "a1");
  assertEquals(matchAsset([stock, gen], "").match, null);
  assertEquals(matchAsset([stock, gen], "").options.length, 2);
  assertEquals(matchAsset([stock, gen, old], "the generator").match?.id, "a2");
  assertEquals(matchAsset([stock, gen, old], "my tomatoes").match?.id, "a1");
  assertEquals(matchAsset([stock, gen, old], "a3").match?.id, "a3", "by id, even released");
  assertEquals(matchAsset([stock, gen], "motorcycle").match, null);
});

Deno.test("nextStep: photo, then two witnesses, then an inspection", () => {
  assertEquals(nextStep(asset()), "photo");
  assertEquals(nextStep(asset({ level: "evidence_verified" })), "witnesses");
  assertEquals(nextStep(asset({ level: "evidence_verified", witnesses_confirmed: 1, witnesses_waiting: 1 })), "wait_witnesses");
  assertEquals(nextStep(asset({ level: "evidence_verified", witnesses_waiting: 1 })), "witnesses");
  assertEquals(nextStep(asset({ level: "community_verified" })), "inspection");
  assertEquals(nextStep(asset({ level: "community_verified", inspection_waiting: true })), "wait_inspection");
  assertEquals(nextStep(asset({ level: "independently_verified" })), null);
  assertEquals(nextStep(asset({ level: "independently_verified", status: "under_review" })), "photo");
  assertEquals(nextStep(asset({ status: "stolen" })), null);
});

Deno.test("statusChange: lost/stolen/damaged, found or repaired back to review, released not while pledged", () => {
  assertEquals(statusChange("active", "stolen", false), { ok: true, to: "stolen" });
  assertEquals(statusChange("stolen", "found", false), { ok: true, to: "under_review" });
  assertEquals(statusChange("damaged", "repaired", false), { ok: true, to: "under_review" });
  assert(!statusChange("active", "found", false).ok);
  assert(!statusChange("active", "active", false).ok, "she can't make it active herself");
  assert(!statusChange("active", "sold", false).ok);
  assertEquals(statusChange("active", "released", false), { ok: true, to: "released" });
  const r = statusChange("active", "released", true);
  assert(!r.ok && r.error === "asset_pledged");
  assert(!statusChange("released", "lost", false).ok);
  assert(!statusChange("lost", "lost", false).ok);
});

Deno.test("valueMinor and approx: whole naira, kobo out; place rounded to about 1 km", () => {
  assertEquals(valueMinor("90,000"), 9_000_000n);
  assertEquals(valueMinor("₦90000"), 9_000_000n);
  assertEquals(valueMinor("90k"), 9_000_000n);
  assertEquals(valueMinor(150000), 15_000_000n);
  assertEquals(valueMinor("0"), null);
  assertEquals(valueMinor("12.50"), null, "no floats");
  assertEquals(valueMinor("-5"), null);
  assertEquals(valueMinor("200000000"), null, "over the cap");
  assertEquals(approx(6.524379, 90), 6.52);
  assertEquals(approx("3.3792", 180), 3.38);
  assertEquals(approx(200, 180), null);
  assertEquals(approx("x", 90), null);
});

// --- The tools, against an in-memory store -------------------------------------------------------

function memStore() {
  const assets: Asset[] = [];
  const requests: { id: string; asset_id: string; who: Who }[] = [];
  const photos: number[] = [];
  const store: AssetStore = {
    list: async (u) => assets.filter((a) => a.user_id === u),
    create: async (u, a) => {
      const x = asset({ id: crypto.randomUUID(), user_id: u, ...a });
      assets.push(x);
      return x;
    },
    evidence: async (_u, id, jpeg) => {
      photos.push(jpeg.length);
      const a = assets.find((x) => x.id === id)!;
      Object.assign(a, { evidence_at: "now", status: a.status === "under_review" ? "active" : a.status, level: a.level === "registered" ? "evidence_verified" : a.level });
      return a;
    },
    candidates: async (): Promise<Candidate[]> => [
      { kind: "user", id: "amaka", name: "Amaka Obi", how: "paid", eligible: true },
      { kind: "user", id: "new", name: "Tobi", how: "ajo", eligible: false },
      { kind: "agent", id: "bisi", name: "Mama Bisi", how: "agent", eligible: true },
    ],
    requestWitness: async (_u, id, who) => {
      requests.push({ id: crypto.randomUUID(), asset_id: id, who });
      assets.find((x) => x.id === id)!.witnesses_waiting++;
      return { ok: true };
    },
    requestInspection: async () => ({ ok: true }),
    setStatus: async (_u, id, status) => Object.assign(assets.find((x) => x.id === id)!, { status }),
    requestsFor: async () => [],
    answer: async () => ({ ok: true }),
  };
  return { store, assets, requests, photos };
}

const KEMI = { id: "u1", market_id: "ng", name: "Kemi", language: "en", kyc_tier: 2 } as User;
const ctx = (store: AssetStore, args: Record<string, unknown>, channel: "app" | "voice" = "voice") =>
  ({ user: KEMI, channel, store: {} as NgContext["store"], args, ngntSac: "", codeSecret: "", assets: store }) as NgContext;
// A tiny valid-looking JPEG (starts FF D8), big enough to pass the length check.
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, ...new Array(1200).fill(7)));

Deno.test("assets by voice: register, photo on screen only, witnesses, report", async () => {
  const m = memStore();
  let r = await ASSET_TOOLS.register_asset(ctx(m.store, { type: "okada", description: "Okada for deliveries", value: "350,000" }));
  assert(r.ok, r.text);
  assertEquals(m.assets[0].type, "motorcycle");
  assertEquals(m.assets[0].estimated_value, 35_000_000n);
  assert(String(r.text).includes("350,000 naira"));

  r = await ASSET_TOOLS.register_asset(ctx(m.store, { type: "house", description: "My house", value: 1 }));
  assertEquals(r.error, "invalid_type");
  r = await ASSET_TOOLS.register_asset(ctx(m.store, { type: "stock", description: "Rice", value: "a lot" }));
  assertEquals(r.error, "invalid_value");

  r = await ASSET_TOOLS.asset_photo(ctx(m.store, { photo: JPEG }));
  assertEquals(r.error, "app_only", "the photo is never taken by voice");
  r = await ASSET_TOOLS.ask_witnesses(ctx(m.store, { witnesses: "Amaka" }));
  assertEquals(r.error, "photo_first");

  r = await ASSET_TOOLS.asset_photo(ctx(m.store, { photo: "not a photo" }, "app"));
  assertEquals(r.error, "invalid_photo");
  r = await ASSET_TOOLS.asset_photo(ctx(m.store, { photo: `data:image/jpeg;base64,${JPEG}`, lat: 6.5243, lon: 3.3792 }, "app"));
  assert(r.ok, r.text);
  assertEquals(m.assets[0].level, "evidence_verified");

  r = await ASSET_TOOLS.witness_candidates(ctx(m.store, {}));
  assert(String(r.text).includes("Amaka Obi") && !String(r.text).includes("Tobi"), "only eligible people are offered");

  r = await ASSET_TOOLS.ask_witnesses(ctx(m.store, { witnesses: "Tobi" }));
  assertEquals(r.error, "unknown_witness", "an ineligible person can't be asked");
  r = await ASSET_TOOLS.ask_witnesses(ctx(m.store, { witnesses: "Amaka and Mama Bisi" }));
  assert(r.ok, r.text);
  assertEquals(m.requests.map((x) => x.who), [{ user_id: "amaka" }, { helper_id: "bisi" }]);

  r = await ASSET_TOOLS.request_inspection(ctx(m.store, {}));
  assertEquals(r.error, "not_yet", "inspection comes after two witnesses");

  r = await ASSET_TOOLS.report_asset(ctx(m.store, { asset: "okada", status: "stolen" }));
  assert(r.ok, r.text);
  assertEquals(m.assets[0].status, "stolen");
  r = await ASSET_TOOLS.report_asset(ctx(m.store, { asset: "okada", status: "found" }));
  assertEquals(m.assets[0].status, "under_review");
  assert(String(r.text).includes("new live photo"));
});

Deno.test("report_asset: a pledged asset can't be released", async () => {
  const m = memStore();
  m.assets.push(asset({ pledged: true, level: "independently_verified" }));
  const r = await ASSET_TOOLS.report_asset(ctx(m.store, { status: "released" }));
  assertEquals(r.error, "asset_pledged");
  assertEquals(m.assets[0].status, "active");
});

Deno.test("my_assets: never shows the confidence score", async () => {
  const m = memStore();
  m.assets.push({ ...asset(), confidence: 85 } as Asset);
  const r = await ASSET_TOOLS.my_assets(ctx(m.store, {}));
  assert(!JSON.stringify(r).includes("confidence"));
  assert(!JSON.stringify(r).includes("85"));
});
