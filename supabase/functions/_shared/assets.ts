// Assets (piece 5): the rules, pure so they are unit-tested. The store (store-assets.ts) does the I/O.
//
// Levels, only ever up: registered -> evidence_verified (a live photo) -> community_verified (two
// eligible witnesses) -> independently_verified (an agent inspects it). Statuses: active,
// under_review, lost, stolen, damaged, released. Only active assets count for lending.
import type { AssetLevel } from "./markets.ts";

export const ASSET_TYPES = ["stock", "tools", "machine", "motorcycle", "livestock"] as const;
export type AssetType = typeof ASSET_TYPES[number];
export const ASSET_STATUSES = ["active", "under_review", "lost", "stolen", "damaged", "released"] as const;
export type AssetStatus = typeof ASSET_STATUSES[number];

export interface Asset {
  id: string;
  user_id: string;
  type: AssetType;
  description: string;
  estimated_value: bigint;
  level: AssetLevel;
  status: AssetStatus;
  evidence_at: string | null;
  inspected_at: string | null;
  created_at: string;
  /** Community witnesses: confirmed and still waiting. */
  witnesses_confirmed: number;
  witnesses_waiting: number;
  inspection_waiting: boolean;
  /** Collateral for an open loan. */
  pledged: boolean;
}

/** Words she might use, to a type. */
const TYPE_WORDS: [AssetType, RegExp][] = [
  ["motorcycle", /\b(motor ?cycle|motorbike|okada|bike|keke|tricycle|scooter)\b/i],
  ["livestock", /\b(livestock|goats?|cows?|sheep|chickens?|fowls?|pigs?|rams?|animals?|poultry)\b/i],
  ["machine", /\b(machines?|generator|gen|grinder|sewing|freezer|fridge|oven|mill|blender)\b/i],
  ["tools", /\b(tools?|equipment|hammer|spanner|clippers?|kit)\b/i],
  ["stock", /\b(stock|goods|inventory|wares|products?|tomatoes|pepper|provisions?|fabric|cloth)\b/i],
];
export function parseAssetType(v: unknown): AssetType | null {
  const s = String(v ?? "").trim().toLowerCase();
  if ((ASSET_TYPES as readonly string[]).includes(s)) return s as AssetType;
  return TYPE_WORDS.find(([, r]) => r.test(s))?.[0] ?? null;
}

/** Her asset by what she calls it ("my stall stock", "the generator"), or by id. */
export function matchAsset(assets: Asset[], query: unknown): { match: Asset | null; options: Asset[] } {
  const open = assets.filter((a) => a.status !== "released");
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return open.length === 1 ? { match: open[0], options: [] } : { match: null, options: open };
  const byId = assets.find((a) => a.id === q);
  if (byId) return { match: byId, options: [] };
  const words = q.replace(/\b(my|the|our|her|a|an)\b/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const type = parseAssetType(q);
  const scored = open.map((a) => {
    const d = a.description.toLowerCase();
    let s = words.filter((w) => d.includes(w)).length * 2;
    if (type && a.type === type) s += 1;
    return { a, s };
  }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  if (scored.length === 0) return { match: null, options: open };
  if (scored.length === 1 || scored[0].s > scored[1].s) return { match: scored[0].a, options: [] };
  return { match: null, options: scored.filter((x) => x.s === scored[0].s).map((x) => x.a) };
}

/** What she can do next to raise the level. */
export function nextStep(a: Pick<Asset, "level" | "status" | "evidence_at" | "witnesses_confirmed" | "witnesses_waiting" | "inspection_waiting">):
  "photo" | "witnesses" | "inspection" | "wait_witnesses" | "wait_inspection" | null {
  if (a.status === "released" || a.status === "lost" || a.status === "stolen") return null;
  if (a.status === "under_review") return a.inspection_waiting ? "wait_inspection" : "photo";
  if (a.level === "independently_verified") return null;
  if (a.level === "registered") return "photo";
  if (a.level === "evidence_verified") return a.witnesses_confirmed + a.witnesses_waiting >= 2 ? "wait_witnesses" : "witnesses";
  return a.inspection_waiting ? "wait_inspection" : "inspection";
}

/**
 * What she may change it to. Lost, stolen or damaged: it stops counting. Found or repaired: under
 * review until a new live photo (or an inspection). Released (sold, given away, no longer hers): not
 * while it backs an open loan.
 */
export function statusChange(from: AssetStatus, to: string, pledged: boolean): { ok: true; to: AssetStatus } | { ok: false; error: string; text: string } {
  const want = to === "found" || to === "repaired" ? "under_review" : to;
  if (!(ASSET_STATUSES as readonly string[]).includes(want) || want === "active") {
    return { ok: false, error: "invalid_status", text: "She can mark it lost, stolen, damaged, found, repaired, or no longer hers (released)." };
  }
  if (from === "released") return { ok: false, error: "released", text: "That asset is released; register it again if she has it back." };
  if (want === from) return { ok: false, error: "no_change", text: `It is already ${statusWords(from)}.` };
  if (want === "under_review" && !["lost", "stolen", "damaged"].includes(from)) {
    return { ok: false, error: "invalid_status", text: "Only a lost, stolen or damaged asset can be marked found or repaired." };
  }
  if (want === "released" && pledged) {
    return { ok: false, error: "asset_pledged", text: "It backs her loan; it can be released once the loan is repaid." };
  }
  return { ok: true, to: want as AssetStatus };
}

export function statusWords(s: AssetStatus | string): string {
  return s === "under_review" ? "under review" : s;
}

/** Major units to kobo, whole naira only; null when not a positive amount. */
export function valueMinor(v: unknown, max = 100_000_000n): bigint | null {
  const s = String(v ?? "").replace(/[₦,\s]|naira/gi, "").trim().toLowerCase();
  const m = /^(\d+)(k)?$/.exec(s);
  if (!m) return null;
  const n = BigInt(m[1]) * (m[2] ? 1000n : 1n) * 100n;
  return n > 0n && n <= max * 100n ? n : null;
}

/** Approximate location: 2 decimals (about 1 km), or null. */
export function approx(v: unknown, limit: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 100) / 100;
}

// --- The store (implemented in store-assets.ts; declared here so the tools stay free of supabase-js) ---

export type Who = { user_id: string; helper_id?: undefined } | { helper_id: string; user_id?: undefined };

export interface Candidate {
  kind: "user" | "agent";
  id: string;
  name: string;
  /** How she knows them: "ajo", "paid", "agent". */
  how: string;
  eligible: boolean;
}

export interface WitnessRequest {
  id: string;
  kind: "community" | "inspection";
  asset_id: string;
  owner_name: string;
  type: AssetType;
  description: string;
  estimated_value: bigint;
  level: string;
  status: string;
  evidence_at: string | null;
  photo_url: string | null;
  created_at: string;
}

export interface AssetStore {
  list(userId: string): Promise<Asset[]>;
  create(userId: string, a: { type: AssetType; description: string; estimated_value: bigint }): Promise<Asset>;
  /** A live photo: hashed, stored privately, the hash and an approximate place saved; the level recomputed. */
  evidence(userId: string, assetId: string, jpeg: Uint8Array<ArrayBuffer>, lat: number | null, lon: number | null): Promise<Asset>;
  candidates(userId: string): Promise<Candidate[]>;
  requestWitness(userId: string, assetId: string, who: Who): Promise<{ ok: boolean; error?: string }>;
  requestInspection(userId: string, assetId: string): Promise<{ ok: boolean; error?: string }>;
  setStatus(userId: string, assetId: string, status: AssetStatus, note: string): Promise<Asset>;
  /** Requests waiting for this person (a Plus user or an agent; agents also see inspections in their market). */
  requestsFor(who: Who, marketId: string): Promise<WitnessRequest[]>;
  answer(requestId: string, who: Who, marketId: string, confirm: boolean, note: string | null, value: bigint | null): Promise<{ ok: boolean; error?: string; asset?: Asset }>;
}
