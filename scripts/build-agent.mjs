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
|   node scripts/build-agent.mjs              debug, for `tauri dev`. Cargo builds
|                                             the exe into target/srbk-agent/debug,
|                                             and this copies it to dev/bin for
|                                             agents to run. See "The Build
|                                             Folder" and "The Debug Copy" below.
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

/*
|--------------------------------------------------------------------------
| The Build Folder
|--------------------------------------------------------------------------
|
| The sidecar builds into a target folder of its own, not target/debug, and
| nothing is ever run from it: dev agents run the copy in dev/bin, and a release
| ships the copy in binaries/.
|
| An agent holds the exe it started open for as long as its session runs, and
| Windows will not let cargo overwrite a running exe. The dev/bin copy was meant
| to keep agents out of target/debug, but the moment that copy went missing the
| app handed out target/debug instead, an agent was connected to it, and every
| dev build after that died on "failed to remove file ... Access is denied".
| With its own folder, no path an agent could have been given sits where cargo
| writes, whatever happened to the copy.
|
*/

const AGENT_TARGET_DIR = path.join(TAURI_DIR, "target", "srbk-agent");

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

const args = [
  "build",
  "-p",
  "srbk-agent",
  "--manifest-path",
  MANIFEST,
  "--target-dir",
  AGENT_TARGET_DIR,
];
if (release) args.push("--release");

// Inherited, so cargo's own errors land in the build output rather than being
// swallowed and reported here as a missing file three lines later.
execFileSync("cargo", args, { stdio: "inherit" });

const built = path.join(AGENT_TARGET_DIR, release ? "release" : "debug", "srbk-agent.exe");
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
| A locked copy means an agent is running it at this moment. Windows will not
| overwrite a running exe but it WILL rename one, so the running copy is moved
| aside under a dated name and this build takes its place. The agent keeps
| running on the old file untouched, the next agent to start gets this build,
| and the dev build never fails because of it. Copies set aside earlier are
| deleted on the way in once nothing is running them any more.
|
*/

if (!release) {
  fs.mkdirSync(DEV_BIN_DIR, { recursive: true });
  const copy = path.join(DEV_BIN_DIR, "srbk-agent.exe");

  for (const name of fs.readdirSync(DEV_BIN_DIR)) {
    if (!name.startsWith("srbk-agent.exe.old-")) continue;
    try {
      fs.unlinkSync(path.join(DEV_BIN_DIR, name));
    } catch {
      // Still running. It goes next time.
    }
  }

  try {
    fs.copyFileSync(built, copy);
  } catch (error) {
    if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
    const aside = `${copy}.old-${Date.now()}`;
    fs.renameSync(copy, aside);
    fs.copyFileSync(built, copy);
    console.log(`srbk-agent: an agent is running the previous copy; it was moved aside to ${path.basename(aside)}`);
  }
  console.log(`srbk-agent: ${copy}`);
  process.exit(0);
}

fs.mkdirSync(BINARIES_DIR, { recursive: true });
const destination = path.join(BINARIES_DIR, `srbk-agent-${hostTriple()}.exe`);
fs.copyFileSync(built, destination);
console.log(`srbk-agent: ${destination}`);
