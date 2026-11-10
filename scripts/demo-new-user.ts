// pnpm demo:new-user — a fresh test person for rehearsals, signed up through the real sign-up
// (the same agent-tools steps the app and the voice agent use) on a test number.
//
//   pnpm demo:new-user                     next free test number, tier 2 (NIN), wallet on Stellar
//   pnpm demo:new-user --tier 1            name, phone and selfie only (low limits, no advances)
//   pnpm demo:new-user --name "Bola Ade"   choose the name
//   pnpm demo:new-user --fund 5000         then a simulated bank transfer of ₦5,000 into the wallet
//   pnpm demo:new-user --free              only print the next free test number, for a live sign-up
//
// Test numbers are +234 700 000 0xxx (market pack, onboarding.demoPhonePrefix): their codes show on
// screen, and signing up again with one archives the earlier test person (history is kept).
// The PIN printed here is a test PIN for this rehearsal person only (DEMO_NEW_USER_PIN to choose it).
import { getMarket } from "../packages/markets/src/markets.ts";
import { plusFetch, signUp, testNin, testPin } from "./lib/onboard.ts";
import { adminClient, loadLocalEnv } from "./lib/supabase-admin.ts";

loadLocalEnv();
const { db, url } = adminClient();
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!anon) throw new Error("VITE_SUPABASE_ANON_KEY is not set in .env.local");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const EXPERT = "https://stellar.expert/explorer/testnet";
const prefix = getMarket("ng").onboarding.demoPhonePrefix; // +2347000000

const NAMES = ["Adaeze Okafor", "Bola Adeyemi", "Chiamaka Eze", "Kemi Balogun", "Ngozi Obi", "Hauwa Musa", "Yetunde Ajayi"];

/** The next test number nobody active holds (from +234 700 000 0201 up; 0101 is kept for live demos). */
async function nextFreeNumber(): Promise<string> {
  const { data } = await db.from("users").select("wa_phone").like("wa_phone", `${prefix}%`).is("archived_at", null);
  const used = new Set((data ?? []).map((r) => r.wa_phone as string));
  for (let n = 201; n < 1000; n++) {
    const phone = `${prefix}${String(n).padStart(3, "0")}`;
    if (!used.has(phone)) return phone;
  }
  throw new Error("no free test numbers left");
}

const local = (e164: string) => `0${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}`;

async function main() {
  const phone = arg("phone") ?? await nextFreeNumber();
  if (process.argv.includes("--free")) {
    console.log(`Next free test number: ${local(phone)} (${phone}). Its code will show on screen.`);
    return;
  }
  const tier = arg("tier") === "1" ? 1 : 2;
  const name = arg("name") ?? NAMES[Math.floor(Math.random() * NAMES.length)];
  const pin = process.env.DEMO_NEW_USER_PIN ?? testPin();
  console.log(`New test person: ${name}, ${local(phone)}, tier ${tier}`);
  const u = await signUp(url, anon!, { name, language: "en", phone, pin, nin: tier === 2 ? testNin() : undefined }, console.log);

  const fund = arg("fund");
  if (fund) {
    const t0 = Date.now();
    const r = await plusFetch(url)("agent-tools/simulate_bank_transfer", { amount: fund, sender: "Rehearsal top-up" }, u.accessToken);
    if (!r.ok) throw new Error(`fund: ${r.error} ${r.text}`);
    for (;;) {
      const { data } = await db.from("transactions").select("status, chain_tx_hash").eq("id", r.transaction_id).single();
      if (data?.status === "completed") {
        console.log(`  ✓ bank transfer ₦${fund} in ${((Date.now() - t0) / 1000).toFixed(1)} s  ${EXPERT}/tx/${data.chain_tx_hash}`);
        break;
      }
      if (Date.now() - t0 > 120_000) throw new Error("bank transfer not on Stellar after 2 min");
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  console.log(`
Ready for rehearsal (testnet, simulated money)
  name             ${name}
  phone            ${local(u.phone)}   (sign in on /app: "I have an account")
  test PIN         ${pin}
  tier             ${u.tier}
  bank account     ${u.virtualAccount} · Partner bank (simulated)
  wallet           ${EXPERT}/account/${u.wallet}
  wallet created   ${u.walletTx}`);
}

main().catch((err) => {
  console.error(`demo:new-user failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
