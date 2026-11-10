import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { operationFor, railOf, stroopsToAmount } from "./chain-ops.ts";
import { StellarSdk } from "./stellar.ts";

const CONTRACT = "CA4VEZZOSQR3RLPN2SF4FLAB5FVPLYH3C635ZSSIEJDE4ZPADGMFQJP4";
const A = "GCHDENOIJ5JFA3JU3OPW3LZSLHR57HCOHA7ZYQSRYG6MHHOFSAM4CWWZ";
const B = "GAOZ6FG534DO26FMGH2YLMV6X2VFZJT5HIKDJCEDMMOIM2JYRFPPSOJ2";

/** Put one operation in a transaction and read it back, as the network would see it. */
function roundTrip(op: ReturnType<typeof operationFor>) {
  const { TransactionBuilder, Account, Networks } = StellarSdk;
  const tx = new TransactionBuilder(new Account(A, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(op).setTimeout(60).build();
  return tx.operations[0] as unknown as Record<string, unknown>;
}

Deno.test("rails: classic operations go to Horizon, contract calls to RPC", () => {
  assertEquals(railOf("payment"), "horizon");
  assertEquals(railOf("claimable_create"), "horizon");
  assertEquals(railOf("claimable_claim"), "horizon");
  assertEquals(railOf("attest"), "rpc");
  assertEquals(railOf("group_record"), "rpc");
  assertEquals(railOf("contract"), "rpc");
});

Deno.test("amounts: integer stroops to a decimal string, never floats", () => {
  assertEquals(stroopsToAmount("5000000000"), "500");
  assertEquals(stroopsToAmount("1"), "0.0000001");
  assertEquals(stroopsToAmount("12345678901"), "1234.5678901");
  assertThrows(() => stroopsToAmount("0"));
  assertThrows(() => stroopsToAmount("1.5"));
  assertThrows(() => stroopsToAmount("-5"));
});

Deno.test("payment: NGNT to a Stellar address", () => {
  const op = roundTrip(operationFor({ kind: "payment", args: { asset: "NGNT", to: B, amount: "5000000000" } }, CONTRACT));
  assertEquals(op.type, "payment");
  assertEquals(op.destination, B);
  assertEquals(op.amount, "500.0000000");
  assertEquals((op.asset as { code: string }).code, "NGNT");
  assertThrows(() => operationFor({ kind: "payment", args: { asset: "NGNT", to: "nope", amount: "1" } }, CONTRACT));
  assertThrows(() => operationFor({ kind: "payment", args: { asset: "DOGE", to: B, amount: "1" } }, CONTRACT));
});

Deno.test("cash-out: claimable by agents now, by the owner only after 7 days", () => {
  const op = roundTrip(operationFor({
    kind: "claimable_create",
    args: { asset: "NGNT", amount: "20000000000", claimants: [B], owner: A, return_after_secs: 604800 },
  }, CONTRACT));
  assertEquals(op.type, "createClaimableBalance");
  const claimants = op.claimants as InstanceType<typeof StellarSdk.Claimant>[];
  assertEquals(claimants.map((c) => c.destination), [B, A]);
  // Agents: unconditional. Owner: not before 7 days have passed.
  assertEquals(JSON.parse(JSON.stringify(claimants[0].predicate)), "unconditional");
  assertEquals(JSON.parse(JSON.stringify(claimants[1].predicate)), { not: { before_relative_time: "604800" } });
});

Deno.test("contract calls: typed arguments, bad values refused", () => {
  const op = roundTrip(operationFor({
    kind: "contract",
    args: { fn: "group_contribute", args: [{ t: "u32", v: 1 }, { t: "address", v: A }] },
  }, CONTRACT));
  assertEquals(op.type, "invokeHostFunction");
  assertThrows(() => operationFor({ kind: "contract", args: { fn: "Bad-Name", args: [] } }, CONTRACT));
  assertThrows(() => operationFor({ kind: "contract", args: { fn: "f", args: [{ t: "bytes32", v: "xyz" }] } }, CONTRACT));
  assertThrows(() => operationFor({ kind: "attest", args: { kind: "stolen", user_ref: "0".repeat(64), amount: "1", payment_ref: "0".repeat(64) } }, CONTRACT));
});
