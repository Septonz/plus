// scheduler, sync-events and chain-worker run with verify_jwt = false (pg_cron sends no JWT). These tests prove the
// secret check is the only door and that it comes first, for every route:
//   1. jobGate returns 401 for every route and method with no secret, a wrong agent secret, or a
//      cron secret the database doesn't accept; with a valid secret it lets the route run.
//   2. Each function's handler starts with jobGate, and the routes listed here are exactly the
//      routes its source handles (add a route, and this test fails until it is listed here).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { jobGate, type JobDb, privateHealth } from "./cron.ts";

const SECRET = "test-agent-secret-0123456789abcdef0123456789";
Deno.env.set("AGENT_SHARED_SECRET", SECRET);

/** The routes each function serves (path after /functions/v1/<fn>); "" is the function root. */
const ROUTES: Record<string, string[]> = {
  scheduler: ["", "/health", "/warm", "/provision", "/guests", "/guests-nightly"],
  "sync-events": ["", "/health"],
  "chain-worker": ["", "/health"],
};

const CRON_OK = "cron-secret-accepted-by-the-database-0123456789";
const db: JobDb = { rpc: (_fn, args) => Promise.resolve({ data: args.p_secret === CRON_OK, error: null }) };
const req = (fn: string, path: string, method: string, headers: Record<string, string> = {}) =>
  new Request(`https://example.supabase.co/functions/v1/${fn}${path}`, { method, headers, body: method === "POST" ? "{}" : undefined });

for (const [fn, routes] of Object.entries(ROUTES)) {
  for (const path of routes) {
    for (const method of ["GET", "POST"]) {
      Deno.test(`${fn} ${method} ${path || "/"}: 401 without a valid secret`, async () => {
        for (const headers of <Record<string, string>[]>[
          {},
          { "x-plus-secret": "wrong" },
          { "x-plus-secret": "" },
          { "x-plus-cron-secret": "wrong-cron-secret" },
          { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" }, // a JWT is not a job secret
        ]) {
          const r = await jobGate(req(fn, path, method, headers), db, fn);
          assertEquals(r?.status, 401, `${JSON.stringify(headers)} got through`);
        }
      });
      Deno.test(`${fn} ${method} ${path || "/"}: runs with the agent or cron secret`, async () => {
        for (const headers of <Record<string, string>[]>[{ "x-plus-secret": SECRET }, { "x-plus-cron-secret": CRON_OK }]) {
          const r = await jobGate(req(fn, path, method, headers), db, fn);
          if (path === "/health" && method === "GET") assertEquals(r?.status, 200);
          else assertEquals(r, null, "the gate should let the route run");
        }
      });
    }
  }
}

Deno.test("an unset AGENT_SHARED_SECRET never matches an empty header", async () => {
  Deno.env.delete("AGENT_SHARED_SECRET");
  try {
    assertEquals((await jobGate(req("scheduler", "", "POST", { "x-plus-secret": "" }), db, "scheduler"))?.status, 401);
  } finally {
    Deno.env.set("AGENT_SHARED_SECRET", SECRET);
  }
});

for (const fn of Object.keys(ROUTES)) {
  Deno.test(`${fn}: the handler starts with jobGate, and every route it serves is listed`, async () => {
    const src = await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url));
    const serves = src.split("Deno.serve(");
    assertEquals(serves.length, 2, "exactly one Deno.serve");
    const body = serves[1].split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    assertEquals(body[0], `const gate = await jobGate(req, db, "${fn}");`, "jobGate must be the first statement");
    assertEquals(body[1], "if (gate) return gate;");
    assert(!/\bhealth\(req/.test(src), "health() is served by jobGate only, after the secret check");
    const found = ["", "/health", ...[...src.matchAll(/pathname\.endsWith\("([^"]+)"\)/g)].map((m) => m[1])];
    assertEquals([...new Set(found)].sort(), [...ROUTES[fn]].sort(), "routes in the source vs. routes tested here");
  });
}

// payout-sim (verify_jwt = false, approved 2026-11-10): GET /health only with a cron or agent
// secret; every other route falls through to its login check (login-gate.test.ts pins that).
Deno.test("payout-sim /health: 401 without a valid secret, 200 with one", async () => {
  for (const headers of <Record<string, string>[]>[
    {}, { "x-plus-secret": "wrong" }, { "x-plus-cron-secret": "wrong-cron-secret" }, { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" },
  ]) {
    assertEquals((await privateHealth(req("payout-sim", "/health", "GET", headers), db, "payout-sim"))?.status, 401, JSON.stringify(headers));
  }
  for (const headers of <Record<string, string>[]>[{ "x-plus-secret": SECRET }, { "x-plus-cron-secret": CRON_OK }]) {
    assertEquals((await privateHealth(req("payout-sim", "/health", "GET", headers), db, "payout-sim"))?.status, 200);
  }
  for (const path of ["/state_transfer_arrives", "/wages_arrive", ""]) {
    assertEquals(await privateHealth(req("payout-sim", path, "POST"), db, "payout-sim"), null, `${path} goes on to the login check`);
  }
});

Deno.test("payout-sim: privateHealth comes first and health() is not served elsewhere", async () => {
  const src = await Deno.readTextFile(new URL("../payout-sim/index.ts", import.meta.url));
  const body = src.split("Deno.serve(")[1].split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  assertEquals(body[0], `const up = await privateHealth(req, db, "payout-sim");`);
  assertEquals(body[1], "if (up) return up;");
  assert(!/\bhealth\(req/.test(src.replace(/privateHealth\(req/g, "")), "only privateHealth answers /health");
});
