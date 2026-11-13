// Typed commands -> agent-tools calls. Deterministic: no LLM, no network, no imports.
//
// parseCommand("abeg send 2k give Iya Tunde", { market: "ng", payees: ["Iya Tunde"] })
//   -> { kind: "tool", tool: "prepare_pay", args: { payee: "Iya Tunde", amount: 2000 }, echo: "Pay ₦2,000 to Iya Tunde" }
//
// Tool names and args are the ones agent-tools serves (tools-ng.ts NG_VOICE_TOOLS for Nigeria,
// tools.ts VOICE_TOOLS for India) and the navigate client tool's screen enum (agent/ng/tools and
// agent/tools navigate.json). Amounts are whole numbers in MAJOR units (naira, rupees), exactly
// what the prepare_* tools take (they run parseMajorAmount, which turns major units into minor).
// Never a float: a fractional result ("2.5555k", "100.50") is not an amount.
//
// Every money tool here only PREPARES; nothing moves until she confirms on screen.
//
// "ask" options and "unknown" suggestions are complete commands: tapping one should send its
// text straight back through parseCommand.
//
// Lines marked `// check` are Yoruba or Tamil phrasings that need a native speaker's review.
// Group savings (ajo / seettu) is deliberately not handled: that feature is being removed.

export type Market = "ng" | "in";

export interface ParseContext {
  market: Market;
  /** Her saved payee names, as stored. */
  payees: string[];
}

export type Parsed =
  | { kind: "tool"; tool: string; args: Record<string, unknown>; echo: string }
  | { kind: "navigate"; screen: string; echo: string }
  | { kind: "ask"; text: string; options?: string[] }
  | { kind: "unknown"; suggestions: string[] };

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lower case, accents and Yoruba tone/under-dots removed ("ẹgbẹ̀rún" -> "egberun"). */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’‘`]/g, "'");
}

const CURRENCY_PREFIX = new Set(["₦", "₹", "n", "rs", "inr", "ngn"]);
const CURRENCY_SUFFIX = new Set([
  "naira", "nairas", "rupees", "rupee", "rs", "inr", "ngn", "bucks",
  "rooba", "roobai", "rubai", "rupai", // check (Tamil: rupees)
]);

/** Split folded text into words, numbers and currency symbols. "₦2,000", "2.5k", "rs500", "n2000". */
function tokenize(folded: string): string[] {
  const raw = folded.match(/₦|₹|(?<![a-z0-9])(?:n|rs|inr|ngn)\d+(?:[.,]\d+)*[a-z]*|\d+(?:[.,]\d+)*[a-z]*|[a-z][a-z0-9']*/g) ?? [];
  const out: string[] = [];
  for (let t of raw) {
    t = t.replace(/'s$/, "").replace(/'/g, "");
    if (!t) continue;
    let m = /^(n|rs|inr|ngn)(\d[\d.,]*[a-z]*)$/.exec(t); // "n2000", "rs500"
    if (m) {
      out.push(m[1]);
      t = m[2];
    }
    m = /^(\d[\d.,]*)([a-z]+)$/.exec(t); // "2k", "2000naira"
    if (m) out.push(m[1], m[2]);
    else out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/** Word -> value for units and tens (and direct values below 1000). */
const SMALL: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
  tree: 3, tri: 3, fiftin: 15, // Pidgin spellings
  // Yoruba hundreds
  ogorun: 100, igba: 200, oodunrun: 300, irinwo: 400, eedegbeta: 500, egbeta: 600, // check
  eedegberin: 700, egberin: 800, eedegberun: 900, // check
  // Tamil (Tanglish) hundreds
  irunooru: 200, munnooru: 300, naanooru: 400, ainooru: 500, arunooru: 600, ezhunooru: 700, // check
  ennooru: 800, tholaayiram: 900, // check
};
/** Whole amounts of a thousand or more said as one word. */
const BIG: Record<string, number> = {
  egbaa: 2000, // check (Yoruba)
  rendaayiram: 2000, moonaayiram: 3000, naalaayiram: 4000, anjaayiram: 5000, pathaayiram: 10000, // check (Tamil)
};
const HUNDRED = new Set(["hundred", "hundreds", "hondred", "hunred", "undred", "nooru"]); // "nooru": check (Tamil)
const SCALE: Record<string, number> = {
  thousand: 1000, thousands: 1000, tousand: 1000, tousan: 1000, tausand: 1000, tausan: 1000, thousan: 1000, tauzand: 1000,
  k: 1000,
  aayiram: 1000, // check (Tamil)
  egberun: 1000, // check (Yoruba; "egberun meji" = 2000)
  lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000,
  m: 1000000, million: 1000000, millions: 1000000, crore: 10000000, crores: 10000000,
};
/** Yoruba units, only as the multiplier after "egberun" ("egberun meji" = 2000). */
const YO_UNIT: Record<string, number> = { kan: 1, okan: 1, meji: 2, meta: 3, merin: 4, marun: 5, mefa: 6, meje: 7, mejo: 8, mesan: 9, mewa: 10 }; // check
/** Tamil units, only right before a multiplier ("rendu aayiram" = 2000): alone they can be names ("Anju"). */
const TA_UNIT: Record<string, number> = { onnu: 1, rendu: 2, moonu: 3, naalu: 4, anju: 5, aaru: 6, ezhu: 7, ettu: 8, ombodhu: 9, pathu: 10 }; // check
const own = (o: Record<string, number>, k: string | undefined) => k !== undefined && Object.hasOwn(o, k);
const ARTICLE = new Set(["a", "oru"]); // "a thousand"; "oru" (Tamil "one/a"): check
const JOINER = new Set(["and", "ati"]); // "ati" (Yoruba "and"): check

/** A number token: "2,000", "2,00,000" (Indian grouping), "2.5". Fraction kept for exact maths. */
function digitValue(t: string): { n: bigint; d: bigint } | null {
  const m = /^(\d+(?:,\d+)*)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const whole = m[1];
  if (whole.includes(",") && !/^\d{1,3}(,\d{3})+$/.test(whole) && !/^\d{1,2}(,\d{2})*,\d{3}$/.test(whole)) return null;
  const frac = m[2] ?? "";
  return { n: BigInt(whole.replace(/,/g, "") + frac), d: 10n ** BigInt(frac.length) };
}

const isMultiplier = (t: string | undefined) => t !== undefined && (HUNDRED.has(t) || (own(SCALE, t) && t !== "k" && t !== "m"));
const isNumberWord = (t: string, next?: string) =>
  own(SMALL, t) || own(BIG, t) || isMultiplier(t) || ((ARTICLE.has(t) || own(TA_UNIT, t)) && isMultiplier(next));

interface Span {
  start: number;
  end: number;
  /** null when the words look like an amount but are not a whole positive number. */
  value: number | null;
}

/** Find every amount in the tokens: digits ("2,000", "2.5k", "N2000"), words ("two tousand"), mixes ("2 thousand 500"). */
function findAmounts(tokens: string[]): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const startsDigit = digitValue(t) !== null;
    if (!startsDigit && !isNumberWord(t, tokens[i + 1])) {
      i++;
      continue;
    }
    // Read one run of number tokens. total/cur are exact fractions n/d.
    let start = i;
    let total = 0n, cur = 0n, d = 1n, bad = false;
    let lastScale = Infinity;
    let curFromDigits = false;
    let j = i;
    while (j < tokens.length) {
      const w = tokens[j];
      const next = tokens[j + 1];
      const dv = digitValue(w);
      if (dv) {
        // A second plain number right after one ("2000 500") is not the same amount.
        if (j > i && (cur !== 0n || curFromDigits)) break;
        if (j > i && total > 0n && Number(dv.n / dv.d) >= lastScale) break;
        if (dv.d !== 1n) {
          if (d !== 1n) {
            bad = true;
            break;
          }
          total *= dv.d;
          d = dv.d;
          cur = dv.n;
        } else cur += dv.n * d;
        curFromDigits = true;
        j++;
        continue;
      }
      if (JOINER.has(w)) {
        if ((cur !== 0n || total !== 0n) && next !== undefined && (digitValue(next) || isNumberWord(next, tokens[j + 2]))) {
          j++;
          continue;
        }
        break;
      }
      if ((ARTICLE.has(w) || own(TA_UNIT, w)) && isMultiplier(next)) {
        if (cur !== 0n) break;
        cur = (ARTICLE.has(w) ? 1n : BigInt(TA_UNIT[w])) * d;
        j++;
        continue;
      }
      if (w === "k" || w === "m") {
        // only right after a number ("2k", "2 k")
        if (cur === 0n) break;
      }
      if (w === "egberun" && own(YO_UNIT, next)) { // check
        total += (cur === 0n ? d : cur) * 1000n * BigInt(YO_UNIT[next!]);
        cur = 0n;
        curFromDigits = false;
        lastScale = 1000;
        j += 2;
        continue;
      }
      if (own(SCALE, w)) {
        const s = SCALE[w];
        if (s >= lastScale && cur === 0n) break;
        total += (cur === 0n ? d : cur) * BigInt(s);
        cur = 0n;
        curFromDigits = false;
        lastScale = s;
        j++;
        continue;
      }
      if (HUNDRED.has(w)) {
        cur = (cur === 0n ? d : cur) * 100n;
        curFromDigits = false;
        j++;
        continue;
      }
      if (own(BIG, w)) {
        if (cur !== 0n) break;
        total += BigInt(BIG[w]) * d;
        lastScale = 1000;
        j++;
        continue;
      }
      if (own(SMALL, w)) {
        if (curFromDigits) break;
        const v = BigInt(SMALL[w]) * d;
        // "twenty five" is fine; "five twenty" or "two three" is not one number.
        if (cur !== 0n && !(cur % (10n * d) === 0n && cur < 100n * d && v < 10n * d)) {
          if (!(cur % (100n * d) === 0n && v < 100n * d)) break;
        }
        cur += v;
        j++;
        continue;
      }
      break;
    }
    if (j === i) {
      i++;
      continue;
    }
    let end = j;
    // A trailing joiner was never consumed; currency around the run belongs to it.
    if (start > 0 && CURRENCY_PREFIX.has(tokens[start - 1])) start--;
    if (end < tokens.length && CURRENCY_SUFFIX.has(tokens[end])) end++;
    let value: number | null = null;
    if (!bad) {
      const n = total + cur;
      if (n % d === 0n) {
        const v = n / d;
        if (v > 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(v);
      }
    }
    spans.push({ start, end, value });
    i = j;
  }
  return spans;
}

/**
 * The first amount in the text, as a whole number of naira or rupees; null if there is none or it
 * is not a whole positive number. "₦2,000", "N2000", "rs 500", "₹500", "2k", "2.5k" (2500),
 * "two thousand naira", "two tousand", "one thousand five hundred", "ẹgbẹrun meji" (2000), "1 lakh".
 */
export function parseAmount(text: string): number | null {
  const spans = findAmounts(tokenize(fold(text)));
  return spans.length ? spans[0].value : null;
}

/** "₦2,000" / "₹1,00,000": the integer amount with the market's symbol and grouping. */
export function formatAmount(amount: number, market: Market): string {
  const digits = String(Math.trunc(amount));
  if (market === "ng") return "₦" + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (digits.length <= 3) return "₹" + digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `₹${head},${digits.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// Pay codes and phone numbers
// ---------------------------------------------------------------------------

const CODE_STOP = new Set([
  "please", "abeg", "thanks", "naira", "rupees", "hundred", "thousand", "tousand", "amount",
  "for", "the", "and", "now", "pay", "send", "give", "with", "two", "one", "six", "ten", "her", "him",
]);

/** A shop pay code (6 letters/digits, "CN5-2N6", "cn5 2n6", "CN52N6") in Nigeria text. Returns it upper case, no separator. */
function findPayCode(folded: string): { code: string; at: [number, number] } | null {
  // After "shop" / "code": the next 6 characters, with an optional dash or space in the middle.
  const kw = /\b(?:shop|store|merchant|code)\b(?:\s+(?:code|number|no|is))*\s*[:#]?\s*([a-z0-9]{3})([\s-]?)([a-z0-9]{3})\b/g;
  for (const m of folded.matchAll(kw)) {
    const a = m[1], sep = m[2], b = m[3], joined = a + b;
    if (!/[a-z]/.test(joined) && sep !== "-") continue; // "shop 200000" is an amount
    if (sep === " ") {
      if (CODE_STOP.has(a) || CODE_STOP.has(b)) continue;
      if ((/^[a-z]+$/.test(a) && /^\d+$/.test(b)) || (/^\d+$/.test(a) && /^[a-z]+$/.test(b))) continue; // "for 200"
      if (/^\d+$/.test(a) && /^\d+$/.test(b)) continue;
    }
    if (sep === "" && CODE_STOP.has(joined)) continue;
    if (sep === "" && /^\d+k$/.test(joined)) continue;
    const s = m.index! + m[0].length - (a.length + sep.length + b.length);
    return { code: joined.toUpperCase(), at: [s, m.index! + m[0].length] };
  }
  // Anywhere: the dashed form "abc-def" with a letter in it.
  const dashed = /(?<![a-z0-9-])([a-z0-9]{3})-([a-z0-9]{3})(?![a-z0-9-])/g;
  for (const m of folded.matchAll(dashed)) {
    const joined = m[1] + m[2];
    if (!/[a-z]/.test(joined) || /^\d+k$/.test(m[2])) continue;
    return { code: joined.toUpperCase(), at: [m.index!, m.index! + m[0].length] };
  }
  return null;
}

/** A phone number: starts with + or 0 (or 6-9 for a 10-digit Indian mobile), 10 to 13 digits. */
function findPhone(folded: string, market: Market): { phone: string; at: [number, number] } | null {
  for (const m of folded.matchAll(/(?<![\d,.])\+?\d[\d -]{8,16}\d(?![\d,])/g)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 13) continue;
    const ok = raw.startsWith("+") || digits.startsWith("0") || (market === "in" && digits.length === 10 && /^[6-9]/.test(digits));
    if (!ok) continue;
    return { phone: (raw.startsWith("+") ? "+" : "") + digits, at: [m.index!, m.index! + raw.length] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payees
// ---------------------------------------------------------------------------

/** Damerau (optimal string alignment) distance. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Typos allowed for a word of this length: none under 4 letters, 1 up to 7, 2 from 8. */
const typoBudget = (len: number) => (len < 4 ? 0 : len < 8 ? 1 : 2);

const nameWords = (s: string) => fold(s).match(/[a-z0-9\u0080-￿]+/g) ?? [];

/** 3: the whole name; 2: every spoken word is a word of the name ("Tunde" for "Iya Tunde"); 1: the same with small typos; 0: no. */
function scorePayee(spoken: string[], name: string): number {
  const words = nameWords(name);
  if (!spoken.length || !words.length) return 0;
  if (spoken.join("") === words.join("")) return 3;
  const used = new Set<number>();
  let typo = false;
  for (const s of spoken) {
    let hit = words.findIndex((w, k) => !used.has(k) && w === s);
    if (hit < 0) {
      hit = words.findIndex((w, k) => !used.has(k) && editDistance(s, w) <= typoBudget(Math.min(s.length, w.length)));
      if (hit < 0) {
        // The whole name typed as one word with a typo: "iyatunde", "iyatunda".
        const squashed = words.join("");
        if (spoken.length === 1 && editDistance(s, squashed) <= typoBudget(squashed.length)) return 1;
        return 0;
      }
      typo = true;
    }
    used.add(hit);
  }
  return typo ? 1 : 2;
}

/** Words that only describe who she means, tried without when nothing matches. */
const SOFT = new Set(["my", "our", "her", "his", "sister", "brother", "friend", "aunty", "auntie", "uncle", "customer", "person", "oga", "madam"]);

type PayeeHit = { kind: "match"; name: string } | { kind: "ambiguous"; names: string[] } | { kind: "none" };

function matchPayee(spoken: string[], payees: string[]): PayeeHit {
  for (const words of [spoken, spoken.filter((w) => !SOFT.has(w))]) {
    if (!words.length) continue;
    const scored = payees.map((p) => ({ p, s: scorePayee(words, p) })).filter((x) => x.s > 0);
    if (!scored.length) continue;
    const best = Math.max(...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === best).map((x) => x.p);
    return top.length === 1 ? { kind: "match", name: top[0] } : { kind: "ambiguous", names: [...new Set(top)] };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Screens (the navigate tool's enum, without ajo / seettu)
// ---------------------------------------------------------------------------

const SCREENS: Record<Market, Record<string, string[]>> = {
  ng: {
    home: ["home", "main", "start", "dashboard", "front"],
    wallet: ["wallet", "money", "account", "my money", "my account", "my wallet"],
    add_money: ["add money", "top up", "topup", "fund", "fund wallet", "fund account", "deposit", "add cash", "load money"],
    pay: ["pay", "payment", "payments", "send", "send money", "transfer"],
    receive: ["receive", "receive money", "my code", "my pay code", "pay code", "qr", "qr code", "my qr", "my qr code", "collect money"],
    scan: ["scan", "scanner", "scan code", "scan qr", "camera"],
    savings: ["savings", "saving", "my savings", "pot", "savings pot"],
    loan: ["loan", "loans", "my loan", "credit"],
    assets: ["assets", "asset", "my assets", "goods", "my goods", "property", "properties", "my things"],
    cash_out: ["cash out", "cashout", "withdraw", "withdrawal", "cash"],
    activity: ["activity", "history", "transactions", "transaction history", "statement", "my activity", "my history"],
    profile: ["profile", "my profile", "settings", "setting", "account settings", "me"],
  },
  in: {
    home: ["home", "main", "start", "dashboard", "front"],
    money: ["money", "wallet", "account", "my money", "my account", "my wallet", "panam"], // "panam": check (Tamil)
    savings: ["savings", "saving", "my savings", "semippu"], // "semippu": check (Tamil)
    advance: ["advance", "my advance", "loan", "loans", "my loan", "credit"],
    pay: ["pay", "payment", "payments", "send", "send money"],
    activity: ["activity", "history", "transactions", "transaction history", "statement", "my activity", "my history"],
    profile: ["profile", "my profile", "settings", "setting", "account settings", "me"],
  },
};

const SCREEN_LABEL: Record<string, string> = {
  home: "Home", wallet: "Wallet", money: "Money", add_money: "Add money", pay: "Pay", receive: "Receive",
  scan: "Scan", savings: "Savings", loan: "Loan", advance: "Advance", assets: "Assets", cash_out: "Cash out",
  activity: "Activity", profile: "Profile",
};

function screenFor(phrase: string, market: Market): string | null {
  const p = phrase.replace(/^(?:the|my|your)\s+/, "").replace(/\s+(?:screen|page|tab|section|app|menu)$/, "").trim();
  if (!p) return null;
  for (const [screen, words] of Object.entries(SCREENS[market])) {
    if (words.includes(p) || words.includes("my " + p)) return screen;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phrases
// ---------------------------------------------------------------------------

const QUICK: Record<Market, number[]> = { ng: [1000, 2000, 5000], in: [100, 200, 500] };

const PAY_VERB = new RegExp(
  "\\b(?:send|sen|snd|pay|transfer|give|giv|gi" +
    "|ranse|san" + // check (Yoruba: "fi ... ranse si" send to, "san ... fun" pay)
    "|anuppu|anupu|anuppunga|kodu|kudu|kudunga)\\b", // check (Tamil: send, give)
);
const PAY_FILLER = new Set([
  "send", "sen", "snd", "pay", "transfer", "give", "giv", "gi", "abeg", "please", "pls", "plz", "kindly", "make", "i", "wan", "want",
  "to", "the", "for", "am", "money", "cash", "naira", "rupees", "rupee", "rs", "inr", "ngn", "now", "quick", "sharp", "sharply",
  "it", "this", "that", "sum", "of", "go", "let", "me", "can", "you", "help", "do", "a", "an", "just", "dey", "go", "quickly",
  "fi", "ranse", "si", "fun", "san", "owo", "e", "jowo", // check (Yoruba fillers: fi/ranse/si/fun/san/owo/jowo)
  "anuppu", "anupu", "anuppunga", "kodu", "kudu", "kudunga", "ku", "ukku", "kku", "panam", "rooba", "roobai", // check (Tamil)
  "shop", "store", "merchant", "code", "number", "no", "phone", "with", "and", "via",
]);

const QUESTION = /^(?:how|what|wetin|when|whats|can|could|do|does|did|is|am|will|which|show|check|see|view|tell|my|elo|evlo)\b/;
const STATUS_WORD = /\b(?:see|show|check|view|know|status|how|what|wetin|when|due|owe|owing|left|remain|remaining|balance|much|details?)\b/;

/** Balance questions. */
const BALANCE = new RegExp([
  "\\bbalance\\b", "\\bbal\\b",
  "\\bhow much (?:money )?(?:do |have |did )?i (?:get|have|got|dey get|still have|still get|get left|have left)\\b",
  "\\bhow much (?:money )?(?:is |dey |remain |remains |left |dey remain )?(?:in|for|inside) my (?:account|wallet|purse)\\b",
  "\\bwetin (?:dey|remain|i get) (?:for |inside |in |for inside )?my (?:account|wallet|purse)\\b",
  "\\bwetin i get\\b", "\\bmy money\\b", "\\bhow much (?:is )?left\\b",
  "\\belo (?:lo|ni) (?:wa|mo ni)\\b", // check (Yoruba: "elo lo wa ninu apo mi", "elo ni mo ni")
  "\\bowo melo\\b", // check (Yoruba: "owo melo lo wa ninu apo mi")
  "\\bevlo\\b", "\\bevvalavu\\b", "\\bpanam irukk?u\\b", // check (Tamil: "balance evlo", "evvalavu panam irukku")
].join("|"));

const SAVINGS_WORD = /\b(?:savings|saving|my pot|ifipamo|semippu)\b/; // "ifipamo" (Yoruba), "semippu" (Tamil): check
const SAVE_VERB = /\bsave\b|\bput\b|\badd\b|\bkeep\b|\bpamo\b|\bsemi\b/; // "pamo" (Yoruba keep), "semi" (Tamil save): check
const OUT_VERB = /\btake (?:\S+ )?out\b|\btake\b|\bwithdraw\b|\bcomot\b|\bremove\b|\bbring (?:\S+ )?out\b|\bmove (?:\S+ )?out\b|\bcollect\b|\bget\b|\bbreak\b|\bmu\b.*\bjade\b/; // "mu ... jade" (Yoruba bring out): check
const CASHOUT = /\bcash ?out\b|\bcashout\b|\bwithdraw\b|\bwithdrawal\b|\bcomot\b|\b(?:collect|get|take|need|want|wan|bring) (?:\S+ )?(?:\S+ )?cash\b/;
const LOAN_WORD = /\b(?:loan|loans|borrow|advance|gbese|kadan|kadun)\b|\bya owo\b/; // "gbese" (Yoruba debt), "ya owo" (Yoruba borrow), "kadan" (Tamil loan): check
const REPAY = /\brepay\b|\bpay (?:\S+ )?back\b|\bpayback\b|\bpay (?:my |the |off |off my )?(?:loan|advance)\b|\bpay off\b/;
const ACCEPT = /\b(?:accept|take|collect|get|borrow|apply|request|want|wan|need|give me|ya)\b/; // "ya" (Yoruba borrow): check
const SHARE = /\bshare\b|\bsend\b|\bgive\b/;
const RECORD = /\brecord\b|\brecords\b|\bstatement\b|\bhistory\b/;
const NAV_LEAD = /^(?:please |pls |abeg |kindly )?(?:open|go to|goto|go|take me to|carry me go|bring me to|navigate to|launch|show me the|switch to)\b\s*(.*)$/;
const HELP = /^(?:help|menu|what can you do|what can i do|wetin you fit do|wetin i fit do|how does this work|options|commands)$/;

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

const unavailable = (what: string, market: Market, options: string[]): Parsed => ({
  kind: "ask",
  text: `${what} isn't on Plus ${market === "in" ? "India" : "Nigeria"} yet.`,
  options,
});

function suggestions(ctx: ParseContext): string[] {
  const p = ctx.payees.find((n) => n.trim());
  if (ctx.market === "in") {
    return ["Balance", p ? `Pay ₹500 to ${p}` : "My record", "Open savings"];
  }
  return ["What's my balance?", p ? `Send 2k to ${p}` : "Cash out 5000", "Save 1000"];
}

function askAmount(text: string, cmd: (amount: string) => string, market: Market): Parsed {
  return { kind: "ask", text, options: QUICK[market].map((a) => cmd(formatAmount(a, market))) };
}

/**
 * Turn one typed command into an agent-tools call, a screen to open, a question back, or a
 * list of examples. Pure and deterministic.
 */
export function parseCommand(text: string, ctx: ParseContext): Parsed {
  const market = ctx.market;
  // Identical names are one choice here; prepare_pay offers the saved entries itself.
  const payees = [...new Set(ctx.payees.filter((p) => typeof p === "string" && p.trim()))];
  const raw = typeof text === "string" ? text.slice(0, 500) : "";
  let folded = fold(raw).replace(/\s+/g, " ").trim();
  const asked = /\?\s*$/.test(raw);

  // Shop pay code (Nigeria only) and phone number come out first so their digits are not amounts.
  const code = market === "ng" ? findPayCode(folded) : null;
  if (code) folded = folded.slice(0, code.at[0]) + " " + folded.slice(code.at[1]);
  const phone = findPhone(folded, market);
  if (phone) folded = folded.slice(0, phone.at[0]) + " " + folded.slice(phone.at[1]);

  const tokens = tokenize(folded);
  if (!tokens.length && !code && !phone) return { kind: "unknown", suggestions: suggestions(ctx) };

  const spans = findAmounts(tokens);
  const inSpan = (k: number) => spans.some((s) => k >= s.start && k < s.end);
  const rest = tokens.filter((_, k) => !inSpan(k)); // the words, without the amount
  const words = rest.join(" ");
  const all = tokens.join(" ");
  const amountCount = spans.length;
  const amount = amountCount === 1 ? spans[0].value : null;
  const show = (a: number) => formatAmount(a, market);

  // Two amounts, or one that is not a whole number: never guess.
  if (amountCount > 1) {
    const vals = [...new Set(spans.map((s) => s.value).filter((v): v is number => v !== null))];
    return { kind: "ask", text: `I see more than one amount (${vals.map(show).join(", ") || "unclear"}). Which one?` };
  }
  if (amountCount === 1 && amount === null) {
    return { kind: "ask", text: "That amount isn't a whole number. Type it again, like 2000 or 2.5k." };
  }

  if (HELP.test(all)) return { kind: "tool", tool: "help", args: {}, echo: "Show what Plus can do" };

  // Share my record (Nigeria: share_record makes a one-time code for a lender).
  if (RECORD.test(words) && SHARE.test(words) && !/\bopen\b|\bgo to\b/.test(words)) {
    if (market === "ng") return { kind: "tool", tool: "share_record", args: {}, echo: "Share your record with a lender" };
    return { kind: "tool", tool: "my_record", args: {}, echo: "Show your record and its link to share" };
  }
  if (/\b(?:my )?record\b/.test(words)) {
    return { kind: "tool", tool: "my_record", args: {}, echo: "Show your record" };
  }

  // open [screen]
  const nav = NAV_LEAD.exec(words);
  if (nav) {
    const screen = screenFor(nav[1], market);
    if (screen) return { kind: "navigate", screen, echo: `Open ${SCREEN_LABEL[screen]}` };
  }

  // Loans (India: the advance).
  if (LOAN_WORD.test(words) || (/\bowe\b|\bdebt\b/.test(words) && !PAY_VERB.test(words))) {
    if (REPAY.test(words)) {
      if (market === "in") return unavailable("Repaying by typing", market, ["Show my advance"]);
      const args: Record<string, unknown> = amount !== null ? { amount } : {};
      return { kind: "tool", tool: "prepare_loan_repay", args, echo: amount !== null ? `Repay ${show(amount)} on your loan` : "Repay your loan" };
    }
    const status = asked || QUESTION.test(words) || STATUS_WORD.test(words);
    if (!status && ACCEPT.test(words)) {
      if (market === "in") return unavailable("Taking an advance by typing", market, ["Show my advance", "Open advance"]);
      const args: Record<string, unknown> = amount !== null ? { amount } : {};
      return { kind: "tool", tool: "prepare_loan", args, echo: amount !== null ? `Accept a loan of ${show(amount)}` : "Accept your loan offer" };
    }
    if (market === "in") return { kind: "tool", tool: "advance_status", args: {}, echo: "Show your advance" };
    return { kind: "tool", tool: "loan_status", args: {}, echo: "Show your loan" };
  }

  // Take money out of savings.
  const howMuch = amount === null && (asked || /\bhow much\b/.test(words));
  if (SAVINGS_WORD.test(words) && OUT_VERB.test(words) && !howMuch && !/\b(?:into|to)\b (?:my )?savings?\b/.test(words)) {
    if (market === "in") return unavailable("Taking money out of savings by typing", market, ["Open savings"]);
    if (amount === null) return askAmount("How much do you want to take out of savings?", (a) => `Take ${a} out of savings`, market);
    return { kind: "tool", tool: "prepare_withdraw_savings", args: { amount }, echo: `Take ${show(amount)} out of savings` };
  }

  // Cash out with a Plus agent.
  if (CASHOUT.test(words) && !(PAY_VERB.test(words) && !/\bcash ?out\b|\bcashout\b|\bwithdraw/.test(words))) {
    if (market === "in") return unavailable("Cash out", market, ["Balance"]);
    if (amount === null) {
      if (asked || QUESTION.test(words)) return { kind: "navigate", screen: "cash_out", echo: "Open Cash out" };
      return askAmount("How much do you want to cash out?", (a) => `Cash out ${a}`, market);
    }
    return { kind: "tool", tool: "prepare_cashout", args: { amount }, echo: `Cash out ${show(amount)}` };
  }

  // Save, or ask about savings.
  const saveVerb = SAVE_VERB.test(words) && !PAY_VERB.test(words) && (/\bsave\b|\bpamo\b|\bsemi\b/.test(words) || SAVINGS_WORD.test(words));
  const toSavings = PAY_VERB.test(words) && /\b(?:to|into|in|for) (?:my )?(?:savings|saving|pot)\b/.test(words);
  if (saveVerb || toSavings) {
    if (amount === null && (asked || QUESTION.test(words) || /\bhow much\b/.test(words))) {
      if (market === "in") return { kind: "tool", tool: "get_balance", args: {}, echo: "Check your balance and savings" };
      return { kind: "tool", tool: "savings_status", args: {}, echo: "Show your savings" };
    }
    if (market === "in") return unavailable("Saving by typing", market, ["Open savings"]);
    if (amount === null) return askAmount("How much do you want to save?", (a) => `Save ${a}`, market);
    return { kind: "tool", tool: "prepare_save", args: { amount }, echo: `Save ${show(amount)}` };
  }
  if (SAVINGS_WORD.test(words) && !PAY_VERB.test(words)) {
    if (market === "in") return { kind: "tool", tool: "get_balance", args: {}, echo: "Check your balance and savings" };
    return { kind: "tool", tool: "savings_status", args: {}, echo: "Show your savings" };
  }

  // Balance (before pay: "how much I get" has no payee).
  if (BALANCE.test(words) && amount === null && !code && !phone && (!PAY_VERB.test(words) || words.includes("balance"))) {
    return { kind: "tool", tool: "get_balance", args: {}, echo: "Check your balance" };
  }

  // Pay: a shop code, a phone number, or a saved person.
  if (PAY_VERB.test(words) || code || phone || (amount !== null && /\bto\b/.test(words))) {
    const verb = market === "in" ? "Pay" : "Send";
    if (code) {
      const shown = `${code.code.slice(0, 3)}-${code.code.slice(3)}`;
      if (amount === null) return askAmount(`How much do you want to pay shop ${shown}?`, (a) => `Pay ${a} to shop ${shown}`, market);
      return { kind: "tool", tool: "prepare_pay", args: { code: code.code, amount }, echo: `Pay ${show(amount)} to shop ${shown}` };
    }
    const spoken = rest.filter((w) => !PAY_FILLER.has(w) && !CURRENCY_PREFIX.has(w) && !CURRENCY_SUFFIX.has(w));
    if (phone) {
      if (market === "in") {
        return { kind: "ask", text: "On Plus India you pay a saved person by name.", options: payees.slice(0, 4).map((p) => `Pay ${p}`) };
      }
      if (amount === null) return askAmount(`How much do you want to send to ${phone.phone}?`, (a) => `Send ${a} to ${phone.phone}`, market);
      const args: Record<string, unknown> = { phone: phone.phone, amount };
      return { kind: "tool", tool: "prepare_pay", args, echo: `Pay ${show(amount)} to ${phone.phone}` };
    }
    if (!spoken.length) {
      if (market === "ng" && /\b(?:shop|store|merchant|code)\b/.test(words)) {
        return { kind: "ask", text: "What is the shop's pay code? It has 6 letters and numbers, like CN5-2N6." };
      }
      const options = payees.slice(0, 4).map((p) => amount !== null ? `${verb} ${show(amount)} to ${p}` : `${verb} ${p}`);
      return { kind: "ask", text: amount !== null ? `Who do you want to pay ${show(amount)}?` : "Who do you want to pay?", options };
    }
    const hit = matchPayee(spoken, payees);
    if (hit.kind === "ambiguous") {
      const options = hit.names.map((p) => amount !== null ? `${verb} ${show(amount)} to ${p}` : `${verb} ${p}`);
      return { kind: "ask", text: `Which one do you mean: ${hit.names.join(" or ")}?`, options };
    }
    if (hit.kind === "none") {
      if (market === "ng" && /\b(?:shop|store|merchant|code)\b/.test(words)) {
        return { kind: "ask", text: "What is the shop's pay code? It has 6 letters and numbers, like CN5-2N6." };
      }
      const said = rest.filter((w) => !PAY_FILLER.has(w)).join(" ");
      const options = payees.slice(0, 4).map((p) => amount !== null ? `${verb} ${show(amount)} to ${p}` : `${verb} ${p}`);
      return {
        kind: "ask",
        text: payees.length
          ? `I can't find "${said}" in your saved people. Who do you mean?`
          : `You have no saved people yet. ${market === "ng" ? "Pay a shop by its code, or a phone number." : "Save a payee first."}`,
        options,
      };
    }
    if (amount === null) return askAmount(`How much do you want to send to ${hit.name}?`, (a) => `${verb} ${a} to ${hit.name}`, market);
    return { kind: "tool", tool: "prepare_pay", args: { payee: hit.name, amount }, echo: `Pay ${show(amount)} to ${hit.name}` };
  }

  // A bare screen name ("history", "settings"), or "open" + something we don't know.
  const bare = screenFor(words.replace(/^(?:please |pls |abeg )/, ""), market);
  if (bare && amount === null) return { kind: "navigate", screen: bare, echo: `Open ${SCREEN_LABEL[bare]}` };
  if (nav) {
    const opts = Object.keys(SCREENS[market]).filter((s) => ["home", "pay", "savings", "activity"].includes(s));
    return { kind: "ask", text: "Which screen do you want to open?", options: opts.map((s) => `Open ${SCREEN_LABEL[s].toLowerCase()}`) };
  }

  return { kind: "unknown", suggestions: suggestions(ctx) };
}
