// pnpm bindings: regenerate packages/plus-client from the deployed `plus` contract
// (testnet alias) and re-apply our local fixes, so regeneration is always safe:
//   - package name @plus/client, private, TypeScript aligned with the repo
//   - tsconfig "rootDir": "./src" (required by TypeScript 7)
// Then rebuilds the package.
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages", "plus-client");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
// Call pnpm without a shell: npm_execpath (set by pnpm) is either its JS entry or a native pnpm.exe.
const pnpm = (args) => {
  const p = process.env.npm_execpath;
  if (p && /\.[cm]?js$/.test(p)) return run(process.execPath, [p, ...args]);
  if (p && /\.exe$/i.test(p)) return run(p, args);
  return execSync(`pnpm ${args.join(" ")}`, { cwd: ROOT, stdio: "inherit" });
};

run("stellar", [
  "contract", "bindings", "typescript",
  "--network", "testnet",
  "--contract-id", "plus",
  "--output-dir", "packages/plus-client",
  "--overwrite",
]);

// package.json
const pkgPath = join(OUT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.name = "@plus/client";
pkg.private = true;
pkg.devDependencies = { ...pkg.devDependencies, typescript: "~7.0.2" };
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tsconfig.json rootDir
const tscPath = join(OUT, "tsconfig.json");
let tsc = readFileSync(tscPath, "utf8");
if (!/^\s*"rootDir":\s*"\.\/src"/m.test(tsc)) {
  const commented = /^(\s*)\/\/\s*"rootDir":\s*"[^"]*",/m;
  if (commented.test(tsc)) {
    tsc = tsc.replace(commented, '$1"rootDir": "./src",');
  } else {
    tsc = tsc.replace(/"compilerOptions":\s*\{/, '"compilerOptions": {\n    "rootDir": "./src",');
  }
  writeFileSync(tscPath, tsc);
}

pnpm(["install", "--silent"]);
pnpm(["--filter", "@plus/client", "build"]);
console.log("packages/plus-client regenerated as @plus/client");
