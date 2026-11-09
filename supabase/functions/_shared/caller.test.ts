// deno test supabase/functions/_shared/caller.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { callerFromBody, callerPhone } from "./caller.ts";

Deno.test("phone calls: E.164 caller ids pass through", () => {
  assertEquals(callerPhone("+14155552671"), "+14155552671");
  assertEquals(callerPhone(" +91 98765-43210 "), "+919876543210");
});

Deno.test("WhatsApp: user id digits without + become E.164", () => {
  assertEquals(callerPhone("919876543210"), "+919876543210");
  assertEquals(callerPhone("whatsapp:+2348012345678"), "+2348012345678");
});

Deno.test("non-numbers and malformed ids are refused", () => {
  assertEquals(callerPhone("US.13491208655302741918"), null); // BSUID-like
  assertEquals(callerPhone("09876543210"), null); // national format, no country code
  assertEquals(callerPhone("12345"), null);
  assertEquals(callerPhone(""), null);
  assertEquals(callerPhone(undefined), null);
  assertEquals(callerPhone(919876543210), null);
});

Deno.test("body fields: caller_id first, then aliases", () => {
  assertEquals(callerFromBody({ caller_id: "919876543210" }), "+919876543210");
  assertEquals(callerFromBody({ system__caller_id: "+919876543210" }), "+919876543210");
  assertEquals(callerFromBody({ caller_phone: "+2348012345678" }), "+2348012345678");
  assertEquals(callerFromBody({ name: "Selvi" }), null);
});
