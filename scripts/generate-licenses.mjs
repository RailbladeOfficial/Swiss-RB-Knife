#!/usr/bin/env node
/**
 * generate-licenses.mjs
 * Generates THIRD_PARTY_LICENSES.md from npm and Cargo dependencies.
 * Run manually: node generate-licenses.mjs
 * Or automatically as a prebuild hook in package.json.
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

/* =============================================================================
   PATHS
============================================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/*
|--------------------------------------------------------------------------
| Project Root
|--------------------------------------------------------------------------
|
| Script lives in /scripts
| We want the actual project root one level above.
|
*/

const ROOT_DIR = resolve(__dirname, "..");

/*
|--------------------------------------------------------------------------
| Public Directory
|--------------------------------------------------------------------------
*/

const PUBLIC_DIR = join(ROOT_DIR, "public");

/*
|--------------------------------------------------------------------------
| Output File
|--------------------------------------------------------------------------
*/

const OUTPUT_FILE = join(
  PUBLIC_DIR,
  "THIRD_PARTY_LICENSES.md"
);

/*
|--------------------------------------------------------------------------
| Ensure public/ exists
|--------------------------------------------------------------------------
*/

mkdirSync(PUBLIC_DIR, { recursive: true });

/* =============================================================================
   HELPERS
============================================================================= */

function run(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
  } catch (err) {
    return null;
  }
}

function spdxUrl(license) {
  if (!license || license === "UNKNOWN") return null;
  // Handle common compound expressions
  const clean = license.replace(/\(|\)/g, "").split(/\s+(?:OR|AND|WITH)\s+/)[0].trim();
  return `https://spdx.org/licenses/${clean}.html`;
}

/*
|--------------------------------------------------------------------------
| Untrusted-field escaping
|--------------------------------------------------------------------------
|
| Package names, versions, licenses, and repository URLs come from
| third-party tooling (license-checker / cargo-license) and reflect whatever
| a dependency put in its own metadata — i.e. untrusted input. The generated
| THIRD_PARTY_LICENSES.md is displayed in-app by a markdown renderer that
| intentionally passes raw HTML through (for the README), so an unescaped '<'
| in a dependency's name would otherwise become a live tag in that view.
| Neutralise the HTML-significant characters, and '|' which would also break
| the surrounding markdown table.
|
*/

function mdText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;");
}

/*
| Returns a safe markdown link target, or null when the value isn't a plain
| http(s) URL. This blocks 'javascript:' / 'data:' schemes and percent-encodes
| the characters that would break '(...)' link syntax or form a tag.
*/

function mdUrl(value) {
  if (!value) return null;
  const url = String(value).trim();
  if (!/^https?:\/\//i.test(url)) return null;
  // encodeURIComponent deliberately leaves "(", ")", and "'" unescaped, so map
  // the link-breaking / tag-forming characters explicitly. Any other
  // whitespace falls back to encodeURIComponent, which does handle it.
  const enc = {
    "(": "%28", ")": "%29", "<": "%3C", ">": "%3E",
    '"': "%22", "'": "%27", " ": "%20", "\t": "%09",
    "\n": "%0A", "\r": "%0D",
  };
  return url.replace(/[()<>"'\s]/g, (c) => enc[c] ?? encodeURIComponent(c));
}

/* =============================================================================
   NPM / NODE DEPENDENCIES
============================================================================= */

function getNpmPackages() {
  console.log("  Fetching npm dependency licenses...");

  // license-checker outputs JSON with package info
  const raw = run("npx --yes license-checker --json --excludePrivatePackages --excludePackages swiss-rb-knife");
  if (!raw) {
    console.warn("  ⚠  Could not run license-checker. Skipping npm packages.");
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("  ⚠  Failed to parse license-checker output. Skipping npm packages.");
    return [];
  }

  return Object.entries(parsed)
    .map(([nameVersion, info]) => {
      // nameVersion is "package@version"
      const atIdx = nameVersion.lastIndexOf("@");
      const name = atIdx > 0 ? nameVersion.slice(0, atIdx) : nameVersion;
      const version = atIdx > 0 ? nameVersion.slice(atIdx + 1) : "unknown";
      return {
        name,
        version,
        license: info.licenses || "UNKNOWN",
        url: info.repository || info.url || null,
        licenseFile: info.licenseFile || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* =============================================================================
   CARGO / RUST DEPENDENCIES
============================================================================= */

function getCargoPackages() {
  console.log("  Fetching Cargo dependency licenses...");

  // cargo-license must be installed: cargo install cargo-license
  const raw = run("cargo license --json", {
    cwd: resolve(ROOT_DIR, "src-tauri"),
  });
  if (!raw) {
    console.warn("  ⚠  Could not run cargo-license (is it installed? `cargo install cargo-license`).");
    console.warn("     Skipping Cargo packages.");
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("  ⚠  Failed to parse cargo-license output. Skipping Cargo packages.");
    return [];
  }

  return parsed
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || "UNKNOWN",
      url: pkg.repository || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* =============================================================================
   MARKDOWN RENDERER
============================================================================= */

function renderSection(title, packages) {
  if (packages.length === 0) {
    return `## ${title}\n\n_No packages detected or tool unavailable._\n`;
  }

  const rows = packages
    .map((pkg) => {
      const name = mdText(pkg.name);
      const version = mdText(pkg.version);
      const licenseText = mdText(pkg.license);

      const url = mdUrl(pkg.url);
      const nameCell = url ? `[${name}](${url})` : name;

      const licenseUrl = mdUrl(spdxUrl(pkg.license));
      const licenseCell = licenseUrl
        ? `[${licenseText}](${licenseUrl})`
        : licenseText;

      return `| ${nameCell} | ${version} | ${licenseCell} |`;
    })
    .join("\n");

  return `## ${title}

| Package | Version | License |
|---------|---------|---------|
${rows}
`;
}

/* =============================================================================
   MAIN
============================================================================= */

console.log("\n🔍 Swiss RB Knife — License Generator");
console.log("======================================");

const npmPackages = getNpmPackages();
const cargoPackages = getCargoPackages();
const now = new Date().toISOString().split("T")[0];

const output = `# Third-Party Licenses

Swiss RB Knife makes use of the following open-source packages and libraries.
All credit and gratitude to their respective authors and maintainers.

> **Generated automatically on ${now}.**
> Re-run \`node generate-licenses.mjs\` (or \`npm run build\`) to refresh.

---

${renderSection("Node / npm Dependencies", npmPackages)}
---

${renderSection("Rust / Cargo Dependencies", cargoPackages)}
---

_This file was generated by \`generate-licenses.mjs\`. Do not edit manually._
`;

writeFileSync(OUTPUT_FILE, output, "utf8");

console.log(`\n✅ Written to public/THIRD_PARTY_LICENSES.md`);
console.log(`   ${npmPackages.length} npm package(s), ${cargoPackages.length} Cargo package(s)\n`);
