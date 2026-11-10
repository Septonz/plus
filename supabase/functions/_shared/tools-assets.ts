// Asset tools (piece 5), for her app and the voice agent, and for Plus users asked to witness.
// Registering, the live photo, asking witnesses, an inspection and reporting a change move no money,
// so they need no confirm sheet; each one reads back what changed.
import { levelWords } from "./lending.ts";
import { formatMoney } from "./markets.ts";
import {
  type Asset, type AssetStore, ASSET_TYPES, approx, type Candidate, matchAsset, nextStep, parseAssetType, statusChange, statusWords, valueMinor,
} from "./assets.ts";

import type { NgTool } from "./tools-ng.ts";
import type { ToolResult } from "./tools.ts";

const show = (kobo: bigint) => formatMoney(kobo, "ng");
const say = (kobo: bigint) => `${(kobo / 100n).toLocaleString("en-NG")} naira`;
const MAX_PHOTO_BYTES = 1_500_000;

function refuse(text: string, error: string, extra: Record<string, unknown> = {}): ToolResult {
  return { text, ok: false, error, ...extra };
}

const NEXT_TEXT: Record<string, string> = {
  photo: "Next: a live photo of it, on her screen (she can say \"take the photo\").",
  witnesses: "Next: two people who know her business confirm it (people from her ajo, people she pays, or her agent).",
  wait_witnesses: "Waiting for her witnesses to confirm.",
  inspection: "Next: an agent inspects it (the top level).",
  wait_inspection: "Waiting for an agent to inspect it.",
};

export function assetView(a: Asset) {
  const step = nextStep(a);
  return {
    id: a.id,
    type: a.type,
    description: a.description,
    value_minor: String(a.estimated_value),
    value_text: show(a.estimated_value),
    level: a.level,
    level_text: levelWords(a.level),
    status: a.status,
    status_text: statusWords(a.status),
    counts: a.status === "active",
    witnesses_confirmed: a.witnesses_confirmed,
    witnesses_waiting: a.witnesses_waiting,
    inspection_waiting: a.inspection_waiting,
    pledged: a.pledged,
    photo_at: a.evidence_at,
    next: step,
    next_text: step ? NEXT_TEXT[step] : a.level === "independently_verified" && a.status === "active" ? "Fully verified." : null,
  };
}

function spoken(a: Asset): string {
  const v = assetView(a);
  return `${a.description} (${say(a.estimated_value)}): ${v.level_text}${a.status !== "active" ? `, ${v.status_text}` : ""}.`;
}

async function pick(store: AssetStore, userId: string, query: unknown): Promise<Asset | ToolResult> {
  const { match, options } = matchAsset(await store.list(userId), query);
  if (match) return match;
  if (options.length === 0) return refuse("She has no assets registered yet. She can register one: what it is, and what it is worth.", "no_assets");
  return refuse(`Which one? ${options.map((o) => o.description).join("; ")}.`, "which_asset", { options: options.map(assetView) });
}
const isResult = (x: Asset | ToolResult): x is ToolResult => "text" in x;

/** Her assets, each with its level, status and the next step. */
export const ngMyAssets: NgTool = async ({ user, assets }) => {
  const list = await assets!.list(user.id);
  const open = list.filter((a) => a.status !== "released");
  return {
    ok: true,
    text: open.length === 0
      ? "She has no assets registered yet. Anything she uses for her business counts: stock, tools, a machine, a motorcycle, livestock."
      : `Her assets: ${open.map(spoken).join(" ")} Only active, verified assets count toward a loan.`,
    assets: list.map(assetView),
  };
};

/** Register what she owns: type, description, estimated value. */
export const ngRegisterAsset: NgTool = async ({ user, assets, args }) => {
  const type = parseAssetType(args.type ?? args.description);
  if (!type) return refuse(`What kind of thing is it? ${ASSET_TYPES.join(", ")}.`, "invalid_type");
  const description = String(args.description ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (description.length < 2) return refuse("What is it? Ask her to describe it in a few words, like \"stall stock, tomatoes\".", "invalid_description");
  const value = valueMinor(args.value ?? args.estimated_value);
  if (!value) return refuse("What is it worth, in naira? Ask her for a rough value.", "invalid_value");
  const existing = (await assets!.list(user.id)).filter((a) => a.status !== "released");
  if (existing.length >= 10) return refuse("She already has 10 assets registered.", "too_many");
  const a = await assets!.create(user.id, { type, description, estimated_value: value });
  return {
    ok: true,
    text: `Registered: ${description}, about ${say(value)}. Level: registered. ${NEXT_TEXT.photo}`,
    asset: assetView(a),
  };
};

/** The live photo (app only: the camera on her screen sends it). Stored privately; only its hash is kept. */
export const ngAssetPhoto: NgTool = async ({ user, assets, args, channel }) => {
  if (channel !== "app") return refuse("The photo is taken on her screen. Ask her to open the asset and tap Take the photo, or say \"take the photo\".", "app_only");
  const a = await pick(assets!, user.id, args.asset_id);
  if (isResult(a)) return a;
  if (a.status === "released" || a.status === "lost" || a.status === "stolen") return refuse(`It is marked ${statusWords(a.status)}.`, "not_active");
  const b64 = String(args.photo ?? "").replace(/^data:image\/jpeg;base64,/, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64) || b64.length < 1000) return refuse("The photo did not come through. Take it again.", "invalid_photo");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return refuse("The photo did not come through. Take it again.", "invalid_photo");
  const updated = await assets!.evidence(user.id, a.id, bytes, approx(args.lat, 90), approx(args.lon, 180));
  const v = assetView(updated);
  return { ok: true, text: `Photo saved with the time and place. ${a.description} is now ${v.level_text}. ${v.next_text ?? ""}`.trim(), asset: v };
};

function candidateView(c: Candidate) {
  return { kind: c.kind, id: c.id, name: c.name, how: c.how, eligible: c.eligible };
}

/** Who she can ask to confirm (eligible: verified ID, 6+ weeks with Plus, good standing; or her agent). */
export const ngWitnessCandidates: NgTool = async ({ user, assets }) => {
  const cs = await assets!.candidates(user.id);
  const ok = cs.filter((c) => c.eligible);
  return {
    ok: true,
    text: ok.length
      ? `She can ask: ${ok.map((c) => `${c.name} (${c.how === "agent" ? "Plus agent" : c.how === "ajo" ? "her ajo" : "someone she pays"})`).join(", ")}. Two need to confirm.`
      : "Nobody she knows on Plus can witness yet (they need a verified ID and 6 weeks with Plus). Her Plus agent can.",
    candidates: cs.map(candidateView),
  };
};

/** Ask two (or more) people to confirm it exists and is hers. */
export const ngAskWitnesses: NgTool = async ({ user, assets, args }) => {
  const a = await pick(assets!, user.id, args.asset_id ?? args.asset);
  if (isResult(a)) return a;
  if (a.level === "registered") return refuse(`First a live photo of ${a.description}. ${NEXT_TEXT.photo}`, "photo_first");
  if (a.status !== "active") return refuse(`It is ${statusWords(a.status)}; witnesses can confirm it once it is active.`, "not_active");
  const cs = (await assets!.candidates(user.id)).filter((c) => c.eligible);
  const wanted = (Array.isArray(args.witnesses) ? args.witnesses : String(args.witnesses ?? "").split(/,|\band\b/))
    .map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return refuse(`Who should confirm it? She can ask: ${cs.map((c) => c.name).join(", ")}.`, "who", { candidates: cs.map(candidateView) });
  const chosen: Candidate[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const c = cs.find((x) => x.id === w) ?? cs.find((x) => x.name.toLowerCase() === w) ?? cs.find((x) => x.name.toLowerCase().includes(w));
    if (c && !chosen.includes(c)) chosen.push(c);
    else if (!c) unknown.push(w);
  }
  if (chosen.length === 0) return refuse(`I can't find ${unknown.join(", ")} among the people who can witness: ${cs.map((c) => c.name).join(", ")}.`, "unknown_witness", { candidates: cs.map(candidateView) });
  const asked: string[] = [];
  for (const c of chosen) {
    const r = await assets!.requestWitness(user.id, a.id, c.kind === "agent" ? { helper_id: c.id } : { user_id: c.id });
    if (r.ok || r.error === "already_asked") asked.push(c.name);
  }
  const need = Math.max(0, 2 - a.witnesses_confirmed - a.witnesses_waiting - asked.length);
  return {
    ok: true,
    text: `Asked ${asked.join(" and ")} to confirm ${a.description}. They see it on their Plus screen.` +
      (need > 0 ? ` One more person is needed.` : "") + (unknown.length ? ` I couldn't find ${unknown.join(", ")}.` : ""),
    asked,
  };
};

/** Ask an agent to inspect it: the top level. */
export const ngRequestInspection: NgTool = async ({ user, assets, args }) => {
  const a = await pick(assets!, user.id, args.asset_id ?? args.asset);
  if (isResult(a)) return a;
  const step = nextStep(a);
  if (step !== "inspection" && !(a.status === "under_review" && a.level !== "registered")) {
    return refuse(step ? `First: ${NEXT_TEXT[step]}` : `${a.description} is already ${levelWords(a.level)}.`, "not_yet");
  }
  const r = await assets!.requestInspection(user.id, a.id);
  if (!r.ok && r.error !== "already_asked") return refuse("That didn't work. Try again.", "failed");
  return { ok: true, text: `An inspection of ${a.description} is requested. A Plus agent near her checks it in person and confirms its value.` };
};

/** Lost, stolen, damaged, found or repaired, or no longer hers (released). */
export const ngReportAsset: NgTool = async ({ user, assets, args }) => {
  const a = await pick(assets!, user.id, args.asset_id ?? args.asset);
  if (isResult(a)) return a;
  const change = statusChange(a.status, String(args.status ?? "").trim().toLowerCase(), a.pledged);
  if (!change.ok) return refuse(change.text, change.error);
  const note = String(args.note ?? "").trim().slice(0, 120);
  const updated = await assets!.setStatus(user.id, a.id, change.to, note);
  const tail = change.to === "under_review" ? " A new live photo makes it active again."
    : change.to === "released" ? " It no longer counts toward a loan."
    : " It doesn't count toward a loan while it is like this." + (a.pledged ? " Her loan stays the same; nobody else is contacted." : "");
  return { ok: true, text: `${a.description} is now marked ${statusWords(change.to)}.${tail}`, asset: assetView(updated) };
};

// --- Witness side (a Plus user who was asked) ------------------------------------------------------

/** People who asked her to confirm their asset. */
export const ngWitnessRequests: NgTool = async ({ user, assets }) => {
  const rs = (await assets!.requestsFor({ user_id: user.id }, user.market_id)).filter((r) => r.kind === "community");
  return {
    ok: true,
    text: rs.length
      ? `Waiting for her to confirm: ${rs.map((r) => `${r.owner_name}'s ${r.description} (${say(r.estimated_value)})`).join("; ")}. Only confirm what she has seen herself.`
      : "Nobody is waiting for her to confirm anything.",
    requests: rs.map((r) => ({ ...r, estimated_value: String(r.estimated_value), value_text: show(r.estimated_value), level_text: levelWords(r.level) })),
  };
};

/** Confirm (or not) that she knows this asset exists and belongs to them. */
export const ngAnswerWitness: NgTool = async ({ user, assets, args }) => {
  const id = String(args.request_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return refuse("Which request? Open it on the screen.", "invalid_request");
  const confirm = args.confirm === true || args.confirm === "true" || args.confirm === "yes";
  const r = await assets!.answer(id, { user_id: user.id }, user.market_id, confirm, typeof args.note === "string" ? args.note : null, null);
  if (!r.ok) {
    return r.error === "not_eligible_witness"
      ? refuse("To witness, she needs a verified ID, 6 weeks with Plus and good standing.", r.error)
      : refuse("That request is no longer waiting.", r.error ?? "not_found");
  }
  return { ok: true, text: confirm ? "Thank you: confirmed. It helps them build their record." : "Okay: marked as not confirmed. They are not told who said no." };
};

export const ASSET_TOOLS: Record<string, NgTool> = {
  my_assets: ngMyAssets,
  register_asset: ngRegisterAsset,
  asset_photo: ngAssetPhoto,
  witness_candidates: ngWitnessCandidates,
  ask_witnesses: ngAskWitnesses,
  request_inspection: ngRequestInspection,
  report_asset: ngReportAsset,
  witness_requests: ngWitnessRequests,
  answer_witness: ngAnswerWitness,
};
