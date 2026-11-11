// Send to a bank account (piece 7, Nigeria): the bank from the market pack's generic list, a 10-digit
// account number, and a simulated account-name lookup (in production: the partner bank's name
// enquiry). Pure, so it is unit-tested; the money moves in ng_execute_pending_action (bank_send).
import { getMarket } from "./markets.ts";

export type Bank = { code: string; name: string };

export function banks(): Bank[] {
  return getMarket("ng").bankSend?.banks ?? [];
}

/** A bank by its code, or by what she calls it ("Ironwood", "harmattan bank"). */
export function parseBank(v: unknown): Bank | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  const list = banks();
  const byCode = list.find((b) => b.code.toLowerCase() === s);
  if (byCode) return byCode;
  const words = s.replace(/\b(bank|plc|microfinance|trust|the|my|her)\b/g, " ").split(/[^a-z']+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  const hits = list.filter((b) => words.some((w) => b.name.toLowerCase().includes(w)));
  return hits.length === 1 ? hits[0] : null;
}

/** A 10-digit account number (NUBAN length) as said or typed ("0123 456 789"), or null. */
export function accountNumber(v: unknown): string | null {
  const digits = String(v ?? "").replace(/[\s-]/g, "");
  const n = getMarket("ng").bankSend?.accountDigits ?? 10;
  return new RegExp(`^\\d{${n}}$`).test(digits) ? digits : null;
}

/** "•••• 6789": the account as shown and read back (the full number stays in the action). */
export const maskAccount = (acct: string) => `•••• ${acct.slice(-4)}`;
export const spokenAccount = (acct: string) => `ending ${acct.slice(-4).split("").join(" ")}`;

// Demo accounts with fixed names (Funmi's landlord, her supplier); any other number gets a name from
// the fictional list below, the same one every time.
const DEMO_ACCOUNTS: Record<string, string> = {
  "D01:0123456789": "ADEBAYO STORES",
  "D04:2233445566": "IYA TUNDE FOODS",
};
const NAMES = [
  "ADEBAYO STORES", "CHIDI OKEKE", "NGOZI ENTERPRISES", "BOLA ADEYEMI", "HALIMA MUSA", "TUNDE & SONS VENTURES",
  "EMEKA NWOSU", "FOLAKE OGUNDIPE", "IBRAHIM YUSUF", "AMAKA OBI TRADING",
];

/**
 * The simulated name enquiry. "0000000000" and numbers starting 999 are "not found" (to show the
 * refusal in a demo); everything else answers with a fictional name.
 */
export function lookupAccountName(bank: Bank, acct: string): string | null {
  if (acct === "0000000000" || acct.startsWith("999")) return null;
  const fixed = DEMO_ACCOUNTS[`${bank.code}:${acct}`];
  if (fixed) return fixed;
  let h = 0;
  for (const c of `${bank.code}${acct}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return NAMES[h % NAMES.length];
}
