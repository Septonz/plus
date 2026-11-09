// Match what someone said ("poo kadai", "flower shop", "பூக்கடை", "medical kadai") to one of
// her saved payees. Never guesses: if two payees fit equally well the caller gets the options.
//
// Words are mapped to concepts (Tamil, Tanglish and English all land on the same concept), the
// filler words ("kadai", "shop", "ku", "anna"...) are dropped, and each payee is scored by how
// many of the spoken concepts appear in its name.

export interface Payee {
  id: string;
  name: string;
  upi_handle?: string | null;
}

export type PayeeMatch =
  | { kind: "match"; payee: Payee }
  | { kind: "ambiguous"; options: Payee[] }
  | { kind: "none"; options: Payee[] };

// concept -> words that mean it. Lower case; Tamil script as spoken.
const CONCEPTS: Record<string, string[]> = {
  flower: ["flower", "flowers", "florist", "poo", "pu", "poov", "poovu", "pookadai", "pookkadai", "பூ", "பூக்கடை", "பூக்கடைக்கு", "malli", "மல்லி"],
  medical: ["medical", "medicals", "medicine", "medicines", "pharmacy", "chemist", "marunthu", "marundhu", "maruthu", "marunthukadai", "மருந்து", "மருந்துக்கடை", "மெடிக்கல்", "மெடிக்கல்ஸ்"],
  milk: ["milk", "paal", "pal", "aavin", "பால்"],
  vegetable: ["vegetable", "vegetables", "kaikari", "kaai", "காய்கறி"],
  tea: ["tea", "chai", "tea-kadai", "டீ"],
  rice: ["rice", "arisi", "அரிசி"],
  grocery: ["grocery", "provision", "provisions", "maligai", "மளிகை"],
};

// Words that carry no meaning for matching.
const FILLER = new Set([
  "kadai", "kada", "kadaiku", "kadaikku", "kadaila", "shop", "shops", "store", "stores", "the", "to", "for",
  "a", "ku", "kku", "ukku", "anna", "akka", "annan", "sir", "madam", "pay", "send", "anuppu", "anuppunga",
  "kodu", "kudunga", "கடை", "கடைக்கு", "அண்ணா", "அக்கா", "wholesaler", "wholesale", "mandi",
]);

const WORD_TO_CONCEPT = new Map<string, string>();
for (const [concept, words] of Object.entries(CONCEPTS)) {
  for (const w of words) WORD_TO_CONCEPT.set(w, concept);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[.,!?'"()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Concepts in a phrase. Unknown words count as themselves; filler words are dropped. */
export function concepts(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(text)) {
    if (FILLER.has(t)) continue;
    const c = WORD_TO_CONCEPT.get(t) ??
      // "pookadai" style compounds, and Tamil case endings like "பூக்கடைக்கு"
      [...WORD_TO_CONCEPT.entries()].find(([w]) => w.length >= 3 && t.startsWith(w))?.[1];
    out.add(c ?? t);
  }
  return out;
}

export function matchPayee(spoken: string, payees: Payee[]): PayeeMatch {
  const want = concepts(spoken);
  // Only filler words ("kadai"): with one payee that is her; otherwise ask which one.
  if (want.size === 0) {
    return payees.length === 1 ? { kind: "match", payee: payees[0] } : { kind: "ambiguous", options: payees };
  }

  // Exact name match wins outright.
  const exact = payees.filter((p) => p.name.toLowerCase() === spoken.trim().toLowerCase());
  if (exact.length === 1) return { kind: "match", payee: exact[0] };

  const scored = payees.map((p) => {
    const have = concepts(p.name);
    let score = 0;
    for (const c of want) if (have.has(c)) score++;
    return { p, score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best === 0) return { kind: "none", options: payees };
  const top = scored.filter((s) => s.score === best).map((s) => s.p);
  return top.length === 1 ? { kind: "match", payee: top[0] } : { kind: "ambiguous", options: top };
}

/** Rupees as said or typed ("300", "300.50", 300) -> paise. Integers only; no floats. */
export function parseMajorAmount(value: unknown): bigint | null {
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/[,₹\s]|rs\.?|rupees?/gi, "") : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return paise > 0n ? paise : null;
}
