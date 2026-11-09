// Copies packages/markets/src/markets.ts to supabase/functions/_shared/markets.ts.
// Usage: node scripts/sync-markets.mjs          (write the copy)
//        node scripts/sync-markets.mjs --check  (exit 1 if the copy is missing or differs)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "markets", "src", "markets.ts");
const target = join(root, "supabase", "functions", "_shared", "markets.ts");

const HEADER =
  "// GENERATED FILE, DO NOT EDIT.\n" +
  "// Source: packages/markets/src/markets.ts. Edit that file, then run `pnpm markets:sync`.\n\n";

const normalize = (text) => text.replace(/\r\n/g, "\n");
const expected = HEADER + normalize(readFileSync(source, "utf8"));
const rel = relative(root, target).replace(/\\/g, "/");

if (process.argv.includes("--check")) {
  const actual = existsSync(target) ? normalize(readFileSync(target, "utf8")) : null;
  if (actual !== expected) {
    console.error(`${rel} is ${actual === null ? "missing" : "out of date"}. Run: pnpm markets:sync`);
    process.exit(1);
  }
  console.log(`${rel} is in sync.`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected);
  console.log(`Wrote ${rel}`);
}
