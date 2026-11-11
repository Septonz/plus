// Assets in Postgres (service role) and evidence photos in the private Storage bucket asset-evidence.
// Used by agent-tools (her, and Plus users who witness) and agent-api (agents who witness or inspect).
// Only the photo's sha-256 is kept in the database; the photo is read back only as a short-lived
// signed URL for the people checking it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Asset, AssetStore, AssetType, WitnessRequest } from "./assets.ts";
export type { AssetStore, Candidate, WitnessRequest, Who } from "./assets.ts";

const ASSET_COLS = "id, user_id, type, description, estimated_value, level, status, evidence_at, inspected_at, created_at, credit_tx_hash";
const BUCKET = "asset-evidence";

function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export function supabaseAssetStore(db: SupabaseClient): AssetStore {
  async function withCounts(rows: Record<string, unknown>[]): Promise<Asset[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const [w, l] = await Promise.all([
      db.from("asset_witnesses").select("asset_id, kind, status").in("asset_id", ids).in("status", ["requested", "confirmed"]),
      db.from("loans").select("collateral_asset_id").in("collateral_asset_id", ids).in("status", ["active", "late", "restructured"]),
    ]);
    const ws = must(w, "witnesses") as { asset_id: string; kind: string; status: string }[];
    const pledged = new Set((must(l, "loans") as { collateral_asset_id: string }[]).map((x) => x.collateral_asset_id));
    return rows.map((r) => {
      const mine = ws.filter((x) => x.asset_id === r.id);
      return {
        ...(r as unknown as Asset),
        estimated_value: BigInt(String(r.estimated_value)),
        witnesses_confirmed: mine.filter((x) => x.kind === "community" && x.status === "confirmed").length,
        witnesses_waiting: mine.filter((x) => x.kind === "community" && x.status === "requested").length,
        inspection_waiting: mine.some((x) => x.kind === "inspection" && x.status === "requested"),
        pledged: pledged.has(r.id as string),
      };
    });
  }
  async function one(userId: string, assetId: string): Promise<Asset | null> {
    const r = must(await db.from("assets").select(ASSET_COLS).eq("id", assetId).eq("user_id", userId).maybeSingle(), "asset");
    return r ? (await withCounts([r as Record<string, unknown>]))[0] : null;
  }
  async function event(assetId: string, kind: string, note: string | null = null) {
    must(await db.from("asset_events").insert({ asset_id: assetId, kind, note: note?.slice(0, 200) ?? null }), "asset event");
  }
  async function recompute(assetId: string) {
    must(await db.rpc("asset_recompute", { p_asset_id: assetId }), "asset_recompute");
  }

  return {
    async list(userId) {
      const rows = must(await db.from("assets").select(ASSET_COLS).eq("user_id", userId).order("created_at"), "assets") as Record<string, unknown>[];
      return await withCounts(rows);
    },

    async create(userId, a) {
      const row = must(await db.from("assets").insert({
        user_id: userId, type: a.type, description: a.description, estimated_value: a.estimated_value.toString(), confidence: 10,
      }).select(ASSET_COLS).single(), "create asset") as Record<string, unknown>;
      await event(row.id as string, "registered");
      return (await withCounts([row]))[0];
    },

    async evidence(userId, assetId, jpeg, lat, lon) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", jpeg as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, "0")).join("");
      const up = await db.storage.from(BUCKET).upload(`${userId}/${assetId}/${hash}.jpg`, jpeg, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw new Error(`evidence upload: ${up.error.message}`);
      const a = await one(userId, assetId);
      must(await db.from("assets").update({
        evidence_hash: hash, evidence_at: new Date().toISOString(), evidence_lat: lat, evidence_lon: lon,
        // A found or repaired asset comes back once there is a fresh photo of it.
        ...(a?.status === "under_review" ? { status: "active" } : {}),
      }).eq("id", assetId).eq("user_id", userId), "save evidence");
      await event(assetId, "evidence", a?.status === "under_review" ? "new photo; active again" : null);
      await recompute(assetId);
      return (await one(userId, assetId))!;
    },

    async candidates(userId) {
      const me = must(await db.from("users").select("market_id").eq("id", userId).single(), "me") as { market_id: string };
      const groups = (must(await db.from("group_members").select("group_id").eq("user_id", userId), "groups") as { group_id: string }[]).map((g) => g.group_id);
      const ajo = groups.length
        ? must(await db.from("group_members").select("user_id").in("group_id", groups).not("user_id", "is", null).neq("user_id", userId), "ajo") as { user_id: string }[]
        : [];
      const payees = must(await db.from("payees").select("phone, stellar_address").eq("user_id", userId), "payees") as { phone: string | null; stellar_address: string | null }[];
      const phones = payees.map((p) => p.phone).filter((x): x is string => !!x);
      const addrs = payees.map((p) => p.stellar_address).filter((x): x is string => !!x);
      const paid = [
        ...(phones.length ? must(await db.from("users").select("id").in("wa_phone", phones).is("archived_at", null).neq("id", userId), "paid") as { id: string }[] : []),
        ...(addrs.length ? must(await db.from("users").select("id").in("stellar_pub", addrs).is("archived_at", null).neq("id", userId), "paid") as { id: string }[] : []),
      ];
      const how = new Map<string, string>();
      for (const a of ajo) how.set(a.user_id, "ajo");
      for (const p of paid) if (!how.has(p.id)) how.set(p.id, "paid");
      const people = how.size
        ? must(await db.from("users").select("id, name").in("id", [...how.keys()]).is("archived_at", null), "people") as { id: string; name: string | null }[]
        : [];
      const eligible = await Promise.all(people.map(async (p) => must(await db.rpc("asset_witness_eligible", { p_user_id: p.id }), "eligible") as boolean));
      const agents = must(await db.from("helpers").select("id, name").eq("market_id", me.market_id).eq("role", "agent").eq("active", true), "agents") as { id: string; name: string }[];
      return [
        ...people.map((p, i) => ({ kind: "user" as const, id: p.id, name: p.name ?? "Someone", how: how.get(p.id)!, eligible: eligible[i] })),
        ...agents.map((a) => ({ kind: "agent" as const, id: a.id, name: a.name, how: "agent", eligible: true })),
      ];
    },

    async requestWitness(userId, assetId, who) {
      const { error } = await db.from("asset_witnesses").insert({
        asset_id: assetId, kind: "community", witness_user_id: who.user_id ?? null, witness_helper_id: who.helper_id ?? null,
      });
      if (error) return { ok: false, error: error.code === "23505" ? "already_asked" : error.message };
      await event(assetId, "witness_requested");
      return { ok: true };
    },

    async requestInspection(_userId, assetId) {
      const { error } = await db.from("asset_witnesses").insert({ asset_id: assetId, kind: "inspection" });
      if (error) return { ok: false, error: error.code === "23505" ? "already_asked" : error.message };
      await event(assetId, "inspection_requested");
      return { ok: true };
    },

    async setStatus(userId, assetId, status, note) {
      must(await db.from("assets").update({ status }).eq("id", assetId).eq("user_id", userId), "status");
      await event(assetId, "status", `${status}${note ? `: ${note}` : ""}`);
      if (status === "released" || status === "lost" || status === "stolen") {
        // Nobody needs to check something that is gone.
        must(await db.from("asset_witnesses").update({ status: "cancelled", answered_at: new Date().toISOString() })
          .eq("asset_id", assetId).eq("status", "requested"), "cancel requests");
      }
      await recompute(assetId);
      return (await one(userId, assetId))!;
    },

    async requestsFor(who, marketId) {
      let q = db.from("asset_witnesses").select("id, kind, asset_id, status, created_at").eq("status", "requested").order("created_at");
      q = who.user_id ? q.eq("witness_user_id", who.user_id)
        : q.or(`witness_helper_id.eq.${who.helper_id},and(kind.eq.inspection,witness_helper_id.is.null)`);
      const reqs = must(await q, "requests") as { id: string; kind: "community" | "inspection"; asset_id: string; status: string; created_at: string }[];
      if (reqs.length === 0) return [];
      const assets = must(await db.from("assets").select("id, user_id, type, description, estimated_value, level, status, evidence_at, evidence_hash, users!inner(name, market_id)")
        .in("id", reqs.map((r) => r.asset_id)), "assets") as unknown as
        (Record<string, unknown> & { users: { name: string | null; market_id: string }; evidence_hash: string | null })[];
      const out: WitnessRequest[] = [];
      for (const r of reqs) {
        const a = assets.find((x) => x.id === r.asset_id);
        if (!a || a.users.market_id !== marketId) continue;
        const signed = a.evidence_hash
          ? await db.storage.from(BUCKET).createSignedUrl(`${a.user_id}/${a.id}/${a.evidence_hash}.jpg`, 600)
          : null;
        out.push({
          id: r.id, kind: r.kind, asset_id: r.asset_id, owner_name: a.users.name ?? "A Plus customer",
          type: a.type as AssetType, description: String(a.description), estimated_value: BigInt(String(a.estimated_value)),
          level: String(a.level), status: String(a.status), evidence_at: (a.evidence_at as string | null) ?? null,
          photo_url: signed?.data?.signedUrl ?? null, created_at: r.created_at,
        });
      }
      return out;
    },

    async answer(requestId, who, marketId, confirm, note, value) {
      const r = must(await db.from("asset_witnesses").select("id, kind, asset_id, status, witness_user_id, witness_helper_id").eq("id", requestId).maybeSingle(), "request") as
        { id: string; kind: string; asset_id: string; status: string; witness_user_id: string | null; witness_helper_id: string | null } | null;
      if (!r || r.status !== "requested") return { ok: false, error: "not_found" };
      const asset = must(await db.from("assets").select("user_id, status, level, users!inner(market_id)").eq("id", r.asset_id).single(), "asset") as unknown as
        { user_id: string; status: string; level: string; users: { market_id: string } };
      if (asset.users.market_id !== marketId) return { ok: false, error: "not_found" };
      if (r.kind === "community") {
        const mine = who.user_id ? r.witness_user_id === who.user_id : r.witness_helper_id === who.helper_id;
        if (!mine) return { ok: false, error: "not_found" };
        if (who.user_id && !(must(await db.rpc("asset_witness_eligible", { p_user_id: who.user_id }), "eligible") as boolean)) {
          return { ok: false, error: "not_eligible_witness" };
        }
      } else {
        // Inspections: agents only, and not the owner.
        if (!who.helper_id || (r.witness_helper_id && r.witness_helper_id !== who.helper_id)) return { ok: false, error: "not_found" };
      }
      const now = new Date().toISOString();
      const claimed = must(await db.from("asset_witnesses").update({
        status: confirm ? "confirmed" : "declined", answered_at: now, note: note?.slice(0, 200) ?? null,
        ...(r.kind === "inspection" ? { witness_helper_id: who.helper_id } : {}),
      }).eq("id", r.id).eq("status", "requested").select("id"), "answer") as unknown[];
      if (claimed.length === 0) return { ok: false, error: "not_found" };
      if (r.kind === "inspection") {
        if (confirm) {
          must(await db.from("assets").update({
            inspected_at: now, inspected_by: who.helper_id, ...(value ? { inspected_value: value.toString(), estimated_value: value.toString() } : {}),
            ...(asset.status === "under_review" ? { status: "active" } : {}),
          }).eq("id", r.asset_id), "inspected");
          await event(r.asset_id, "inspected", value ? `value ${value}` : null);
        } else {
          must(await db.from("assets").update({ status: "under_review" }).eq("id", r.asset_id), "inspection failed");
          await event(r.asset_id, "inspection_failed", note);
        }
      } else {
        await event(r.asset_id, confirm ? "witness_confirmed" : "witness_declined");
      }
      await recompute(r.asset_id);
      const updated = must(await db.from("assets").select(ASSET_COLS).eq("id", r.asset_id).single(), "asset") as Record<string, unknown>;
      return { ok: true, asset: (await withCounts([updated]))[0] };
    },
  };
}
