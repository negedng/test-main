#!/usr/bin/env ts-node
import { parseArgs } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import {
  REMOTES, PUSH_TRAILER,
  run, runSafe, refExists, listTeamBranches,
  getCurrentBranch, appendTrailer,
  parseShadowIgnore, acquireLock, die,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    message:   { type: "string",  short: "m" },
    remote:    { type: "string",  short: "r" },
    dir:       { type: "string",  short: "d" },
    branch:    { type: "string",  short: "b" },
    "dry-run": { type: "boolean", short: "n" },
    help:      { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help || !values.message) {
  console.log('Usage: shadow-push.ts -m "Your commit message" [-r remote] [-d dir] [-b team-branch] [-n]');
  console.log("  -m  Commit message (required)");
  console.log("  -r  Remote name to push to           (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory to push from  (default: same as remote name)");
  console.log("  -b  Team branch to push to           (default: your current branch)");
  console.log("  -n  Dry run — show what would be pushed without pushing");
  process.exit(values.help ? 0 : 1);
}

const dryRun = values["dry-run"] ?? false;

const commitMsg = values.message;

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR  = path.dirname(
  typeof __filename !== "undefined"
    ? __filename
    : new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const localBranch = getCurrentBranch();

// Resolve remote + dir: explicit flags win, then look up in REMOTES, then fall
// back to the first entry. -r alone infers dir from REMOTES; -d alone is an error.
const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  console.error(`✘ Remote '${values.remote}' not found in REMOTES. Add it to shadow-common.ts.`);
  process.exit(1);
}

const remote     = values.remote ?? remoteEntry!.remote;
const dir        = values.dir    ?? remoteEntry!.dir;
const teamBranch = values.branch ?? localBranch;
const teamRef    = `${remote}/${teamBranch}`;
const localHead  = run(["rev-parse", "HEAD"]);

// Refuse to push if the local dir has uncommitted changes
const dirtyStaged   = !runSafe(["diff", "--cached", "--quiet", "--", `${dir}/`]).ok;
const dirtyUnstaged = !runSafe(["diff", "--quiet", "HEAD", "--", `${dir}/`]).ok;
if (dirtyStaged || dirtyUnstaged) {
  console.error(`✘ '${dir}/' has uncommitted changes:\n`);
  spawnSync("git", ["status", "--short", "--", `${dir}/`], { stdio: "inherit" });
  console.error(`\nCommit or stash them before running shadow-push.`);
  process.exit(1);
}

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Team branch   : ${teamBranch}`);
console.log();

// ── .shadowignore ─────────────────────────────────────────────────────────────

const ignore = parseShadowIgnore(SCRIPT_DIR);

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching latest from remote '${remote}'...`);
run(["fetch", remote]);

let resolvedTeamRef = teamRef;

if (!refExists(teamRef)) {
  console.error(`\n⚠ '${teamRef}' does not exist on the remote.`);
  console.error("Available branches:");
  listTeamBranches(remote).forEach(b => console.error(`  ${b}`));

  // Auto-create the branch from main/master if --branch was explicitly passed,
  // otherwise abort so the user can decide.
  if (!values.branch) {
    die(`Pass -b ${teamBranch} explicitly to confirm creating a new remote branch.`);
  }

  const base = ["main", "master"].find(c => refExists(`${remote}/${c}`));
  if (!base) die(`Could not find a base branch (main/master) on '${remote}'.`);

  resolvedTeamRef = `${remote}/${base}`;
  console.log(`Branching from ${resolvedTeamRef}...`);
}

// ── Worktree ──────────────────────────────────────────────────────────────────

// Normalize to forward slashes so paths work in git shell commands on Windows
const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-push-")).replace(/\\/g, "/");
const archiveDir  = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-archive-")).replace(/\\/g, "/");
const tempBranch  = `shadow-push-${Date.now()}`;
let   cleanupDone = false;

const cleanup = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  runSafe(["worktree", "remove", "--force", worktreeDir]);
  runSafe(["branch", "-D", tempBranch]);
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.rmSync(archiveDir,  { recursive: true, force: true });
};

process.on("exit",    cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

console.log(`Extracting committed '${dir}/' from HEAD...`);
// List files tracked by git in the subdirectory and copy them to archiveDir
const trackedFiles = run(["ls-tree", "-r", "--name-only", "HEAD", "--", `${dir}/`])
  .split("\n")
  .filter(Boolean);

/** Escape a string for use in a RegExp constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const filePath of trackedFiles) {
  // filePath is e.g. "frontend/README.md" — strip the dir prefix
  const relPath = filePath.replace(new RegExp(`^${escapeRegExp(dir)}/`), "");
  const destPath = path.join(archiveDir, relPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Extract file content from git index using array-form spawnSync
  const gitPath = filePath.replace(/\\/g, "/");
  const result = spawnSync("git", ["show", `HEAD:${gitPath}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) die(`Failed to extract ${gitPath} from HEAD`);
  fs.writeFileSync(destPath, result.stdout);
}

run(["worktree", "add", "-b", tempBranch, worktreeDir, resolvedTeamRef]);

console.log(`Syncing into temporary worktree...`);

// Mirror archiveDir into worktreeDir (like rsync --delete), skipping .git and .shadowignore patterns
function syncDirs(src: string, dest: string, ignorePatterns: string[]) {
  // Remove files in dest that aren't in src (except .git and ignored patterns)
  const destFiles = listAllFiles(dest);
  for (const rel of destFiles) {
    if (rel.startsWith(".git/") || rel === ".git") continue;
    if (ignorePatterns.some(p => rel.match(globToRegex(p)))) continue;
    const srcPath = path.join(src, rel);
    if (!fs.existsSync(srcPath)) {
      fs.rmSync(path.join(dest, rel), { force: true });
    }
  }
  // Copy all files from src to dest
  const srcFiles = listAllFiles(src);
  for (const rel of srcFiles) {
    if (ignorePatterns.some(p => rel.match(globToRegex(p)))) continue;
    const srcPath = path.join(src, rel);
    const destPath = path.join(dest, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
}

function listAllFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      results.push(...listAllFiles(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // ** matches across directory boundaries
      re += ".*";
      i += 2;
      // skip trailing / after ** (e.g., **/)
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      // * matches anything except /
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      // Pass through bracket expressions
      const close = pattern.indexOf("]", i + 1);
      if (close !== -1) {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      } else {
        re += "\\[";
        i++;
      }
    } else if (".+^${}()|\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

syncDirs(archiveDir, worktreeDir, ignore.patterns);

// ── Commit & push ─────────────────────────────────────────────────────────────

run(["add", "-A"], worktreeDir);

const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"], worktreeDir).ok;
if (!hasStagedChanges) {
  console.log("No changes to push — their repo is already up to date.");
  cleanup();
  process.exit(0);
}

console.log("\nChanges to be pushed:");
spawnSync("git", ["diff", "--cached", "--stat"], { cwd: worktreeDir, stdio: "inherit" });
console.log();

if (dryRun) {
  console.log("[DRY RUN] No changes were pushed.");
  cleanup();
  process.exit(0);
}

const fullMsg = appendTrailer(commitMsg, `${PUSH_TRAILER}: ${localHead}`);
const commitResult = spawnSync("git", ["commit", "-m", fullMsg], {
  cwd: worktreeDir,
  encoding: "utf8",
  stdio: "inherit",
});
if (commitResult.status !== 0) die("git commit failed in worktree.");

console.log(`Pushing to ${remote}/${teamBranch}...`);
run(["push", remote, `HEAD:${teamBranch}`], worktreeDir);

cleanup();

console.log();
console.log(`✓ Done. Pushed '${dir}/' → ${remote}/${teamBranch} as: "${commitMsg}"`);
