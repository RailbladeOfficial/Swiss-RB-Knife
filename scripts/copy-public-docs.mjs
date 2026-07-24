import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
|--------------------------------------------------------------------------
| Resolve Paths
|--------------------------------------------------------------------------
|
| __dirname does not exist in native ES modules (.mjs),
| so we recreate it manually.
|
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
|--------------------------------------------------------------------------
| Project Paths
|--------------------------------------------------------------------------
*/

const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

/*
|--------------------------------------------------------------------------
| Files To Copy
|--------------------------------------------------------------------------
|
| These files will be copied from the project root
| into the public directory before dev/build.
|
*/

const FILES_TO_COPY = [
  "README.md",
  "LICENSE",
  "LICENSING.md",
  "ATTRIBUTION.md",
  "CONTRIBUTING.md",
  "CHANGELOG.json",
  "SECURITY.md",
  "swiss-rb-knife-logo.png",
  "screenshots",
];

/*
|--------------------------------------------------------------------------
| Ensure Public Directory Exists
|--------------------------------------------------------------------------
*/

async function ensurePublicDir() {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
}

/*
|--------------------------------------------------------------------------
| Copy Files
|--------------------------------------------------------------------------
*/

async function copyFiles() {
  console.log("📄 Copying documentation/license files to public/");

  for (const fileName of FILES_TO_COPY) {
    const sourcePath = path.join(ROOT_DIR, fileName);
    const destinationPath = path.join(PUBLIC_DIR, fileName);

    try {
      // Remove any existing copy first so the result is an exact mirror of
      // the source. Without this, fs.cp MERGES into an existing folder —
      // screenshots deleted or renamed at the root would live on as ghosts
      // in public/ (and end up bundled into the build) forever.
      await fs.rm(destinationPath, { recursive: true, force: true });

      // fs.cp handles both plain files and directories (recursive), unlike
      // fs.copyFile which throws EISDIR on folders.
      await fs.cp(sourcePath, destinationPath, { recursive: true });

      console.log(`✅ Copied: ${fileName}`);
    } catch (error) {
      console.error(`❌ Failed to copy: ${fileName}`);
      console.error(error.message);
    }
  }
}

/*
|--------------------------------------------------------------------------
| Main
|--------------------------------------------------------------------------
*/

async function main() {
  try {
    await ensurePublicDir();
    await copyFiles();

    console.log("🎉 Public documentation sync complete.");
  } catch (error) {
    console.error("❌ Fatal error while syncing public docs.");
    console.error(error);

    process.exit(1);
  }
}

main();