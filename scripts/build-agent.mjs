import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
|--------------------------------------------------------------------------
| Build The Agent Sidecar
|--------------------------------------------------------------------------
|
| srbk-agent.exe is the small program an AI agent spawns to talk to this app
| about one Kanban board. It is a SEPARATE crate rather than a second [[bin]]
| in src-tauri, because src-tauri/build.rs stamps its binaries with a
| requireAdministrator manifest and a sidecar carrying that would raise a UAC
| prompt every single time an agent started it.
|
| Being a separate crate is also why this script exists: `cargo build` in a
| directory that is both a package and a workspace root builds only that
| package, so the app's own build never touches the sidecar. Nothing else would
| notice it was missing until an agent tried to connect.
|
| Two modes:
|
|   node scripts/build-agent.mjs              debug, for `tauri dev`. Cargo puts
|                                             the exe in target/debug, beside the
|                                             dev app binary, and this copies it
|                                             to dev/bin for agents to run. See
|                                             "The Debug Copy" below for why.
|
|   node scripts/build-agent.mjs --release    release, for `tauri build`. Copies
|                                             the exe to src-tauri/binaries under
|                                             the target-triple name Tauri's
|                                             externalBin requires, from where
|                                             the installer picks it up and
|                                             installs it beside the app.
|
*/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const TAURI_DIR = path.join(ROOT_DIR, "src-tauri");
const MANIFEST = path.join(TAURI_DIR, "Cargo.toml");
const BINARIES_DIR = path.join(TAURI_DIR, "binaries");
const DEV_BIN_DIR = path.join(ROOT_DIR, "dev", "bin");

const release = process.argv.includes("--release");

/*
|--------------------------------------------------------------------------
| Target Triple
|--------------------------------------------------------------------------
|
| Tauri identifies a sidecar by the triple in its filename, and refuses to
| bundle one whose name does not match the target being built. Asked of rustc
| rather than assumed, so a build on a different host still produces a name
| Tauri accepts.
|
*/

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"));
  if (!line) throw new Error("rustc did not report a host triple");
  return line.slice("host:".length).trim();
}

/*
|--------------------------------------------------------------------------
| Build
|--------------------------------------------------------------------------
*/

const args = ["build", "-p", "srbk-agent", "--manifest-path", MANIFEST];
if (release) args.push("--release");

// Inherited, so cargo's own errors land in the build output rather than being
// swallowed and reported here as a missing file three lines later.
execFileSync("cargo", args, { stdio: "inherit" });

const built = path.join(TAURI_DIR, "target", release ? "release" : "debug", "srbk-agent.exe");
if (!fs.existsSync(built)) {
  throw new Error(`cargo reported success but ${built} is not there`);
}

/*
|--------------------------------------------------------------------------
| The Debug Copy
|--------------------------------------------------------------------------
|
| An AI agent spawns srbk-agent.exe and holds it open for the whole session,
| and Windows will not let cargo overwrite a running exe. So an agent pointed
| at target/debug breaks the NEXT dev build: cargo tries to relink the very
| file the agent is holding, and the build dies before the app ever starts.
|
| A debug build therefore leaves a copy outside target/, and that copy is the
| one the Agents tab hands out (see sidecar_path() in src-tauri/src/agent_gate.rs).
| Cargo keeps target/debug to itself and is never blocked by a running agent.
|
| A locked destination means an agent is running the copy at this moment. That
| is a warning rather than a failure: the old copy stays, the running agent
| keeps working, and it picks up this build whenever it is next started.
| Failing here would reintroduce the blocked build the copy exists to avoid.
|
*/

if (!release) {
  fs.mkdirSync(DEV_BIN_DIR, { recursive: true });
  const copy = path.join(DEV_BIN_DIR, "srbk-agent.exe");
  try {
    fs.copyFileSync(built, copy);
    console.log(`srbk-agent: ${copy}`);
  } catch (error) {
    if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
    console.warn(`srbk-agent: kept the existing ${copy}, an agent is running it`);
  }
  process.exit(0);
}

fs.mkdirSync(BINARIES_DIR, { recursive: true });
const destination = path.join(BINARIES_DIR, `srbk-agent-${hostTriple()}.exe`);
fs.copyFileSync(built, destination);
console.log(`srbk-agent: ${destination}`);
