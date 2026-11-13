// deno test --no-config --node-modules-dir=none supabase/functions/_shared/intent.test.ts
import { formatAmount, type Market, parseAmount, parseCommand, type Parsed } from "./intent.ts";

function eq(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}

const NG_PAYEES = ["Iya Tunde", "Mama Ngozi", "Chidi Okafor", "Bisi"];
const IN_PAYEES = ["Poo Kadai", "Medical Kadai", "Lakshmi", "Murugan Anna"];
const ng = (t: string, payees = NG_PAYEES) => parseCommand(t, { market: "ng", payees });
const inn = (t: string, payees = IN_PAYEES) => parseCommand(t, { market: "in", payees });

function tool(p: Parsed, name: string, args: Record<string, unknown> = {}, label = "") {
  if (p.kind !== "tool") throw new Error(`${label}: expected tool ${name}, got ${JSON.stringify(p)}`);
  eq(p.tool, name, `${label}: tool`);
  eq(p.args, args, `${label}: args`);
}

// ---------------------------------------------------------------------------
// parseAmount
// ---------------------------------------------------------------------------

const AMOUNTS: [string, number | null][] = [
  ["2000", 2000],
  ["2,000", 2000],
  ["₦2,000", 2000],
  ["₦ 2,000", 2000],
  ["N2000", 2000],
  ["n2,000", 2000],
  ["NGN 5000", 5000],
  ["rs 500", 500],
  ["Rs.500", 500],
  ["rs500", 500],
  ["₹500", 500],
  ["₹1,00,000", 100000],
  ["INR 750", 750],
  ["500 rupees", 500],
  ["2000 naira", 2000],
  ["2000naira", 2000],
  ["2k", 2000],
  ["2K", 2000],
  ["2 k", 2000],
  ["20k", 20000],
  ["2.5k", 2500],
  ["1.25k", 1250],
  ["0.5k", 500],
  ["2.5555k", null], // 2555.5: not a whole amount
  ["100.50", null],
  ["100.00", 100],
  ["1,000,000", 1000000],
  ["1.5m", 1500000],
  ["1 lakh", 100000],
  ["2.5 lakh", 250000],
  ["two thousand", 2000],
  ["five hundred", 500],
  ["one thousand five hundred", 1500],
  ["one thousand and fifty", 1050],
  ["two thousand naira", 2000],
  ["two tousand", 2000],
  ["tree tausand", 3000],
  ["a thousand", 1000],
  ["twenty five thousand", 25000],
  ["two hundred and fifty", 250],
  ["2 thousand", 2000],
  ["2 thousand 500", 2500],
  ["ẹgbẹrun meji", 2000], // Yoruba
  ["egberun kan", 1000],
  ["egberun meji ati eedegbeta", 2500],
  ["ẹẹdẹgbẹta", 500],
  ["rendu aayiram", 2000], // Tamil
  ["ainooru rooba", 500],
  ["rendaayiram ainooru", 2500],
  ["", null],
  ["hello", null],
  ["0", null],
  ["zero", null],
  ["k", null],
  ["anju", null], // a name, not 5
  ["-", null],
  ["20,00", null], // bad grouping
];

Deno.test("parseAmount: digits, k, words, currencies", () => {
  for (const [text, want] of AMOUNTS) eq(parseAmount(text), want, `parseAmount(${JSON.stringify(text)})`);
});

Deno.test("parseAmount: finds the amount inside a sentence and only ever returns safe integers", () => {
  eq(parseAmount("abeg send 2k give Iya Tunde"), 2000);
  eq(parseAmount("pay Bisi two thousand five hundred naira now"), 2500);
  for (const [text] of AMOUNTS) {
    const v = parseAmount(text);
    if (v !== null && !Number.isSafeInteger(v)) throw new Error(`${text} -> ${v} is not an integer`);
  }
  eq(parseAmount("99999999999999999999"), null);
});

Deno.test("formatAmount: naira and Indian grouping", () => {
  eq(formatAmount(2000, "ng"), "₦2,000");
  eq(formatAmount(1500000, "ng"), "₦1,500,000");
  eq(formatAmount(500, "in"), "₹500");
  eq(formatAmount(100000, "in"), "₹1,00,000");
  eq(formatAmount(12345678, "in"), "₹1,23,45,678");
});

// ---------------------------------------------------------------------------
// Nigeria phrasings: [text, tool, args]
// ---------------------------------------------------------------------------

const NG_CASES: [string, string, Record<string, unknown>][] = [
  // balance
  ["balance", "get_balance", {}],
  ["What's my balance?", "get_balance", {}],
  ["check balance", "get_balance", {}],
  ["how much do I have", "get_balance", {}],
  ["how much I get", "get_balance", {}],
  ["How much money I get?", "get_balance", {}],
  ["wetin dey my account", "get_balance", {}],
  ["wetin remain for my wallet", "get_balance", {}],
  ["how much is in my account", "get_balance", {}],
  ["elo lo wa ninu apo mi", "get_balance", {}], // Yoruba
  ["Ẹ̀lò ló wà nínú àpò mi?", "get_balance", {}], // Yoruba with tones
  ["owo melo lo wa ninu apo mi", "get_balance", {}], // Yoruba
  // pay a saved person
  ["send 2000 to Iya Tunde", "prepare_pay", { payee: "Iya Tunde", amount: 2000 }],
  ["Send ₦2,000 to Iya Tunde", "prepare_pay", { payee: "Iya Tunde", amount: 2000 }],
  ["abeg send 2k give Iya Tunde", "prepare_pay", { payee: "Iya Tunde", amount: 2000 }],
  ["pay Bisi 500", "prepare_pay", { payee: "Bisi", amount: 500 }],
  ["pay bisi N500", "prepare_pay", { payee: "Bisi", amount: 500 }],
  ["transfer 2.5k to mama ngozi", "prepare_pay", { payee: "Mama Ngozi", amount: 2500 }],
  ["send two thousand naira to Chidi", "prepare_pay", { payee: "Chidi Okafor", amount: 2000 }],
  ["send two tousand give chidi", "prepare_pay", { payee: "Chidi Okafor", amount: 2000 }],
  ["give Ngozi 1,500", "prepare_pay", { payee: "Mama Ngozi", amount: 1500 }],
  ["send 1000 to iya tunde's", "prepare_pay", { payee: "Iya Tunde", amount: 1000 }],
  ["pay 300 to iyatunde", "prepare_pay", { payee: "Iya Tunde", amount: 300 }],
  ["send 5k to Tundee", "prepare_pay", { payee: "Iya Tunde", amount: 5000 }], // typo
  ["send 5k to chdi", "prepare_pay", { payee: "Chidi Okafor", amount: 5000 }], // typo
  ["send 400 to Ngozzi", "prepare_pay", { payee: "Mama Ngozi", amount: 400 }], // typo
  ["make I send 700 give my sister Bisi", "prepare_pay", { payee: "Bisi", amount: 700 }],
  ["please pay one thousand five hundred to Bisi", "prepare_pay", { payee: "Bisi", amount: 1500 }],
  ["fi ẹgbẹrun meji ranṣẹ si Iya Tunde", "prepare_pay", { payee: "Iya Tunde", amount: 2000 }], // Yoruba
  ["fi egberun kan ranse si Bisi", "prepare_pay", { payee: "Bisi", amount: 1000 }], // Yoruba
  ["san eedegbeta fun Mama Ngozi", "prepare_pay", { payee: "Mama Ngozi", amount: 500 }], // Yoruba
  ["2000 to Bisi", "prepare_pay", { payee: "Bisi", amount: 2000 }],
  ["abeg, send 2k give Iya Tunde!", "prepare_pay", { payee: "Iya Tunde", amount: 2000 }],
  ["I want to send 500 to Bisi", "prepare_pay", { payee: "Bisi", amount: 500 }],
  ["send 500 cash to Bisi", "prepare_pay", { payee: "Bisi", amount: 500 }],
  // pay by phone
  ["send 5000 to 08031234567", "prepare_pay", { phone: "08031234567", amount: 5000 }],
  ["send 5k to +234 803 123 4567", "prepare_pay", { phone: "+2348031234567", amount: 5000 }],
  // pay a shop by code
  ["pay shop CN5-2N6 2000", "prepare_pay", { code: "CN52N6", amount: 2000 }],
  ["pay shop cn52n6 ₦1,500", "prepare_pay", { code: "CN52N6", amount: 1500 }],
  ["pay shop cn5 2n6 500", "prepare_pay", { code: "CN52N6", amount: 500 }],
  ["pay 2k to shop K7Q-2MX", "prepare_pay", { code: "K7Q2MX", amount: 2000 }],
  ["pay code K7Q2MX 750", "prepare_pay", { code: "K7Q2MX", amount: 750 }],
  ["pay shop code is abc-def 300", "prepare_pay", { code: "ABCDEF", amount: 300 }],
  ["Pay CN5-2N6 2000", "prepare_pay", { code: "CN52N6", amount: 2000 }],
  ["pay shop 234-567 1000", "prepare_pay", { code: "234567", amount: 1000 }],
  // save
  ["save 1000", "prepare_save", { amount: 1000 }],
  ["make I save 1000", "prepare_save", { amount: 1000 }],
  ["Save ₦2,000", "prepare_save", { amount: 2000 }],
  ["save 2k", "prepare_save", { amount: 2000 }],
  ["put 500 in my savings", "prepare_save", { amount: 500 }],
  ["add five hundred to savings", "prepare_save", { amount: 500 }],
  ["send 1000 to my savings", "prepare_save", { amount: 1000 }],
  ["I wan save two tousand", "prepare_save", { amount: 2000 }],
  ["fi egberun kan pamo", "prepare_save", { amount: 1000 }], // Yoruba
  // savings status
  ["how much is in my savings", "savings_status", {}],
  ["my savings", "savings_status", {}],
  ["how much I don save?", "savings_status", {}],
  ["how much I get for savings", "savings_status", {}],
  // take out of savings
  ["take out 500 from savings", "prepare_withdraw_savings", { amount: 500 }],
  ["comot 500 from my savings", "prepare_withdraw_savings", { amount: 500 }],
  ["withdraw 2k from my savings", "prepare_withdraw_savings", { amount: 2000 }],
  ["take 1,000 out of my savings", "prepare_withdraw_savings", { amount: 1000 }],
  ["remove one thousand from savings", "prepare_withdraw_savings", { amount: 1000 }],
  // cash out
  ["cash out 3000", "prepare_cashout", { amount: 3000 }],
  ["I wan cash out 3k", "prepare_cashout", { amount: 3000 }],
  ["cashout ₦5,000", "prepare_cashout", { amount: 5000 }],
  ["withdraw 10k", "prepare_cashout", { amount: 10000 }],
  ["comot 500", "prepare_cashout", { amount: 500 }],
  ["I need 2000 cash", "prepare_cashout", { amount: 2000 }],
  ["make I collect 4k cash", "prepare_cashout", { amount: 4000 }],
  // loans
  ["show my loan", "loan_status", {}],
  ["loan", "loan_status", {}],
  ["how much I owe?", "loan_status", {}],
  ["can I get a loan?", "loan_status", {}],
  ["I want to see my loan", "loan_status", {}],
  ["wetin dey my loan", "loan_status", {}],
  ["accept loan", "prepare_loan", {}],
  ["accept my loan offer", "prepare_loan", {}],
  ["I wan collect loan", "prepare_loan", {}],
  ["take loan of 20k", "prepare_loan", { amount: 20000 }],
  ["give me loan", "prepare_loan", {}],
  ["mo fe ya owo", "prepare_loan", {}], // Yoruba "I want to borrow money"
  ["repay my loan", "prepare_loan_repay", {}],
  ["pay back 2500 on my loan", "prepare_loan_repay", { amount: 2500 }],
  // record
  ["share my record", "share_record", {}],
  ["share my record with the lender", "share_record", {}],
  ["abeg share my record", "share_record", {}],
  ["show my record", "my_record", {}],
  // help
  ["help", "help", {}],
  ["wetin you fit do", "help", {}],
];

Deno.test("Nigeria: English, Pidgin and Yoruba phrasings map to the right tool and args", () => {
  for (const [text, name, args] of NG_CASES) tool(ng(text), name, args, JSON.stringify(text));
});

Deno.test("echo is a short plain restatement with the naira amount", () => {
  eq((ng("abeg send 2k give Iya Tunde") as { echo: string }).echo, "Pay ₦2,000 to Iya Tunde");
  eq((ng("pay shop cn52n6 1500") as { echo: string }).echo, "Pay ₦1,500 to shop CN5-2N6");
  eq((ng("make I save 1000") as { echo: string }).echo, "Save ₦1,000");
  eq((ng("comot 500 from my savings") as { echo: string }).echo, "Take ₦500 out of savings");
  eq((ng("I wan cash out 3k") as { echo: string }).echo, "Cash out ₦3,000");
  eq((ng("balance") as { echo: string }).echo, "Check your balance");
  eq((ng("I wan collect loan") as { echo: string }).echo, "Accept your loan offer");
  eq((ng("share my record") as { echo: string }).echo, "Share your record with a lender");
});

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

const NAV: [Market, string, string][] = [
  ["ng", "open savings", "savings"],
  ["ng", "Open my savings", "savings"],
  ["ng", "go to history", "activity"],
  ["ng", "open activity", "activity"],
  ["ng", "take me to settings", "profile"],
  ["ng", "open the loan screen", "loan"],
  ["ng", "open scan", "scan"],
  ["ng", "open my pay code", "receive"],
  ["ng", "open add money", "add_money"],
  ["ng", "open cash out", "cash_out"],
  ["ng", "carry me go wallet", "wallet"],
  ["ng", "go home", "home"],
  ["ng", "open assets", "assets"],
  ["ng", "history", "activity"],
  ["ng", "settings", "profile"],
  ["in", "open savings", "savings"],
  ["in", "open advance", "advance"],
  ["in", "open loan", "advance"],
  ["in", "go to money", "money"],
  ["in", "open wallet", "money"],
  ["in", "transactions", "activity"],
];

Deno.test("navigate: screen names and synonyms from navigate.json (no ajo, no seettu)", () => {
  for (const [market, text, screen] of NAV) {
    const p = parseCommand(text, { market, payees: [] });
    if (p.kind !== "navigate") throw new Error(`${market} ${text}: ${JSON.stringify(p)}`);
    eq(p.screen, screen, `${market} ${text}`);
  }
  eq(parseCommand("open ajo", { market: "ng", payees: [] }).kind, "ask");
  eq(parseCommand("open seettu", { market: "in", payees: [] }).kind, "ask");
  eq(parseCommand("open loan", { market: "ng", payees: [] }), { kind: "navigate", screen: "loan", echo: "Open Loan" });
});

// ---------------------------------------------------------------------------
// asks: ambiguity, missing amounts, missing payee, bad codes
// ---------------------------------------------------------------------------

Deno.test("ambiguous payee: asks which, with both as tappable commands that resolve", () => {
  const payees = ["Iya Tunde", "Tunde Bakare", "Bisi"];
  const p = parseCommand("send 2k to tunde", { market: "ng", payees });
  if (p.kind !== "ask") throw new Error(JSON.stringify(p));
  eq(p.options, ["Send ₦2,000 to Iya Tunde", "Send ₦2,000 to Tunde Bakare"]);
  tool(parseCommand(p.options![0], { market: "ng", payees }), "prepare_pay", { payee: "Iya Tunde", amount: 2000 });
  tool(parseCommand(p.options![1], { market: "ng", payees }), "prepare_pay", { payee: "Tunde Bakare", amount: 2000 });
  // A full name wins over a first name that also fits.
  tool(parseCommand("send 100 to tunde", { market: "ng", payees: ["Tunde", "Tunde Bakare"] }), "prepare_pay", { payee: "Tunde", amount: 100 });
  // Two payees with one typo each: ask.
  const t = parseCommand("send 100 to ade", { market: "ng", payees: ["Ada", "Ade", "Adebayo"] });
  tool(t, "prepare_pay", { payee: "Ade", amount: 100 });
  const u = parseCommand("send 100 to tolu", { market: "ng", payees: ["Tola", "Tobu"] });
  eq(u.kind, "ask");
  // Same name saved twice: passed on by name; prepare_pay itself offers the two.
  tool(parseCommand("pay bisi 100", { market: "ng", payees: ["Bisi", "Bisi"] }), "prepare_pay", { payee: "Bisi", amount: 100 });
});

Deno.test("no typos allowed on short names", () => {
  const p = parseCommand("send 100 to ada", { market: "ng", payees: ["Ade"] });
  eq(p.kind, "ask");
});

Deno.test("missing amount: asks how much, options are complete commands", () => {
  const p = ng("send money to Iya Tunde");
  if (p.kind !== "ask") throw new Error(JSON.stringify(p));
  eq(p.options, ["Send ₦1,000 to Iya Tunde", "Send ₦2,000 to Iya Tunde", "Send ₦5,000 to Iya Tunde"]);
  tool(ng(p.options![1]), "prepare_pay", { payee: "Iya Tunde", amount: 2000 });
  for (const t of ["save", "make I save", "cash out", "I wan cash out", "take out from savings", "comot from my savings", "pay shop CN5-2N6"]) {
    const q = ng(t);
    if (q.kind !== "ask" || !q.options?.length) throw new Error(`${t}: ${JSON.stringify(q)}`);
    const again = ng(q.options[0]);
    if (again.kind !== "tool") throw new Error(`${t} -> ${q.options[0]}: ${JSON.stringify(again)}`);
  }
});

Deno.test("missing or unknown payee: asks who", () => {
  const p = ng("send 2000");
  if (p.kind !== "ask") throw new Error(JSON.stringify(p));
  eq(p.options![0], "Send ₦2,000 to Iya Tunde");
  const q = ng("send 2000 to Emeka");
  if (q.kind !== "ask") throw new Error(JSON.stringify(q));
  if (!q.text.includes("emeka")) throw new Error(q.text);
  eq(ng("pay", []).kind, "ask");
  eq(ng("send 2k to Emeka", []).kind, "ask");
  eq(ng("pay shop 2000").kind, "ask"); // no code
  eq(ng("send 500 to Bisi so she can save").kind, "ask"); // not a save, and not a clean name either
  eq(ng("pay shop 200000").kind, "ask"); // six digits, no dash: an amount, so still no code
});

Deno.test("amount problems: two amounts or a fraction ask, never guess", () => {
  eq(ng("send 2000 to Bisi 3000").kind, "ask");
  eq(ng("send 2000 3000 to Bisi").kind, "ask");
  eq(ng("save 100.50").kind, "ask");
  eq(ng("send 2.5555k to Bisi").kind, "ask");
});

Deno.test("shop codes: formats accepted, words and amounts not mistaken for codes", () => {
  for (const t of ["pay shop CN5-2N6 2000", "pay shop cn5-2n6 2000", "pay shop CN52N6 2000", "pay shop cn5 2n6 2000", "pay  shop  CN5-2N6  2000", "2000 to shop: CN5-2N6"]) {
    tool(ng(t), "prepare_pay", { code: "CN52N6", amount: 2000 }, t);
  }
  // A saved payee called "... shop" is still a person, not a code.
  tool(ng("pay 2000 to tomato shop", ["Tomato Shop"]), "prepare_pay", { payee: "Tomato Shop", amount: 2000 });
  tool(ng("pay tomato shop 20000", ["Tomato Shop"]), "prepare_pay", { payee: "Tomato Shop", amount: 20000 });
  // "please" is a word, not the code PLEASE.
  eq(ng("pay shop please 500"), { kind: "ask", text: "What is the shop's pay code? It has 6 letters and numbers, like CN5-2N6." });
  eq(ng("pay shop for 200").kind, "ask");
  // India has no pay codes.
  tool(inn("pay 500 to flower shop", ["Flower Shop"]), "prepare_pay", { payee: "Flower Shop", amount: 500 });
});

// ---------------------------------------------------------------------------
// India
// ---------------------------------------------------------------------------

const IN_CASES: [string, string, Record<string, unknown>][] = [
  ["balance", "get_balance", {}],
  ["what is my balance", "get_balance", {}],
  ["balance evlo", "get_balance", {}], // Tamil
  ["evvalavu panam irukku", "get_balance", {}], // Tamil
  ["pay ₹500 to poo kadai", "prepare_pay", { payee: "Poo Kadai", amount: 500 }],
  ["pay rs 200 to Lakshmi", "prepare_pay", { payee: "Lakshmi", amount: 200 }],
  ["send Rs.1,500 to murugan anna", "prepare_pay", { payee: "Murugan Anna", amount: 1500 }],
  ["pay 1 lakh to murugan", "prepare_pay", { payee: "Murugan Anna", amount: 100000 }],
  ["pay ₹1,00,000 to Lakshmi", "prepare_pay", { payee: "Lakshmi", amount: 100000 }],
  ["send five hundred rupees to lakshmi", "prepare_pay", { payee: "Lakshmi", amount: 500 }],
  ["poo kadai-ku 300 anuppu", "prepare_pay", { payee: "Poo Kadai", amount: 300 }], // Tamil
  ["lakshmi-ku ainooru rooba kudunga", "prepare_pay", { payee: "Lakshmi", amount: 500 }], // Tamil
  ["pay medical kadai 2k", "prepare_pay", { payee: "Medical Kadai", amount: 2000 }],
  ["pay Lakshmy 250", "prepare_pay", { payee: "Lakshmi", amount: 250 }], // typo
  ["show my record", "my_record", {}],
  ["share my record", "my_record", {}],
  ["show my advance", "advance_status", {}],
  ["my loan", "advance_status", {}],
  ["my savings", "get_balance", {}],
];

Deno.test("India: rupee phrasings map to the India tools", () => {
  for (const [text, name, args] of IN_CASES) tool(inn(text), name, args, JSON.stringify(text));
  eq((inn("pay ₹1,00,000 to Lakshmi") as { echo: string }).echo, "Pay ₹1,00,000 to Lakshmi");
});

Deno.test("India: a name like Anju is not the number five", () => {
  tool(inn("pay anju 500", ["Anju"]), "prepare_pay", { payee: "Anju", amount: 500 });
});

Deno.test("India: ambiguous kadai asks which", () => {
  const p = inn("pay 100 to kadai");
  if (p.kind !== "ask") throw new Error(JSON.stringify(p));
  eq(p.options, ["Pay ₹100 to Poo Kadai", "Pay ₹100 to Medical Kadai"]);
});

Deno.test("India: features with no India tool ask instead of calling a Nigeria tool", () => {
  for (const t of ["save 500", "cash out 500", "take out 500 from savings", "accept loan", "repay my loan", "send 500 to 9876543210"]) {
    const p = inn(t);
    if (p.kind !== "ask") throw new Error(`${t}: ${JSON.stringify(p)}`);
    for (const o of p.options ?? []) if (inn(o).kind === "unknown") throw new Error(`${t}: option ${o} does not parse`);
  }
  // A pay code in India is not special.
  eq(inn("pay CN5-2N6 2000").kind, "ask");
});

// ---------------------------------------------------------------------------
// unknown
// ---------------------------------------------------------------------------

Deno.test("garbage gives three suggestions that themselves parse", () => {
  for (const market of ["ng", "in"] as Market[]) {
    for (const payees of [market === "ng" ? NG_PAYEES : IN_PAYEES, []]) {
      for (const t of ["", "   ", "asdfgh", "!!!", "12345", "the weather is nice", "🙂", "constructor", "toString", "k"]) {
        const p = parseCommand(t, { market, payees });
        if (p.kind !== "unknown") throw new Error(`${market} ${JSON.stringify(t)}: ${JSON.stringify(p)}`);
        eq(p.suggestions.length, 3);
        for (const s of p.suggestions) {
          const q = parseCommand(s, { market, payees });
          if (q.kind !== "tool" && q.kind !== "navigate") throw new Error(`${market} suggestion ${s}: ${JSON.stringify(q)}`);
        }
      }
    }
  }
  eq((ng("blah") as { suggestions: string[] }).suggestions, ["What's my balance?", "Send 2k to Iya Tunde", "Save 1000"]);
  eq((inn("blah") as { suggestions: string[] }).suggestions, ["Balance", "Pay ₹500 to Poo Kadai", "Open savings"]);
});

Deno.test("never a float, never ajo or seettu tools", () => {
  const all = [...NG_CASES.map(([t]) => ng(t)), ...IN_CASES.map(([t]) => inn(t))];
  for (const p of all) {
    if (p.kind !== "tool") continue;
    if (/ajo|group|seettu/.test(p.tool)) throw new Error(p.tool);
    if ("amount" in p.args && !Number.isSafeInteger(p.args.amount)) throw new Error(JSON.stringify(p));
  }
  eq(parseCommand(123 as unknown as string, { market: "ng", payees: [] }).kind, "unknown");
});

Deno.test("phrasing count", () => {
  const n = NG_CASES.length + IN_CASES.length + NAV.length;
  if (n < 60) throw new Error(`only ${n} phrasings`);
});
