import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyLicenses, duckdbFiles } from "../sql-explorer/duckdb-assets.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const shared = join(root, "../sql-explorer");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "src/plugin.json"), "utf8"));
const duckdbDist = join(shared, "node_modules/@duckdb/duckdb-wasm/dist");

const require = createRequire(import.meta.url);
const agGridStyles = join(dirname(dirname(dirname(require.resolve("ag-grid-community")))), "styles");

const FILES = {
  "assets/icon.svg": join(root, "src/assets/icon.svg"),
  "assets/autosize.svg": join(root, "src/assets/autosize.svg"),
  "backend/grid_server.py": join(root, "backend/grid_server.py"),
  "backend/ssrm.py": join(root, "backend/ssrm.py"),
  "backend/server.py": join(shared, "backend/server.py"),
  "backend/engines.py": join(shared, "backend/engines.py"),
  "backend/identity.py": join(shared, "backend/identity.py"),
  "backend/values.py": join(shared, "backend/values.py"),
  ...(await duckdbFiles(duckdbDist)),
};

const out = join(root, "dist", manifest.id, pkg.version);
rmSync(out, { recursive: true, force: true });
for (const [target, source] of Object.entries(FILES)) {
  mkdirSync(dirname(join(out, target)), { recursive: true });
  copyFileSync(source, join(out, target));
}
cpSync(join(root, "src/skills"), join(out, "skills"), { recursive: true });

const stylesheet = [
  readFileSync(join(shared, "src/entry.css"), "utf8"),
  readFileSync(join(root, "src/entry.css"), "utf8"),
  ...["ag-grid.css", "ag-theme-quartz.css"].map((name) => readFileSync(join(agGridStyles, name), "utf8")),
].join("\n");
writeFileSync(join(out, "entry.css"), stylesheet);

const bundled = await build({
  entryPoints: [join(root, "src/entry.js")],
  outfile: join(out, "entry.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
});

copyLicenses(out, bundled.metafile, duckdbDist);

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function listingDigest(paths) {
  const lines = paths
    .map((path) => relative(out, path).split(sep).join("/"))
    .sort()
    .map((name) => `${name}\0${createHash("sha256").update(readFileSync(join(out, name))).digest("hex")}\n`)
    .join("");
  return `sha256-${createHash("sha256").update(lines).digest("base64url")}`;
}

const checksum = listingDigest(files(out));
writeFileSync(join(out, "plugin.json"), `${JSON.stringify({ ...manifest, version: pkg.version, checksum }, null, 2)}\n`);

console.log(`built ${relative(root, out)}: entry.js ${(statSync(join(out, "entry.js")).size / 1024).toFixed(0)} KiB`);
console.log(`checksum ${checksum}`);
console.log(`version digest ${listingDigest(files(out))}`);
