#!/usr/bin/env ts-node
/**
 * shadow-export.ts — Export local subdirectory changes to a shadow branch
 * using a real git merge, filtering out files matched by .shadowignore.
 *
 * Creates a proper merge commit on the shadow branch with ancestry to
 * your working branch. The commit tree only contains files under dir/,
 * excluding .shadowignore patterns — so ignored files never appear in
 * the shadow branch history.
 *
 * Usage:
 *   npx tsx shadow-export.ts -m "Add login page"
 *   npx tsx shadow-export.ts -r backend -m "Fix API bug"
 *   npx tsx shadow-export.ts -r frontend -b feature/new-page -m "Add new page"
 */
import { parseArgs } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawnSync } from "child_process";
import {
  REMOTES, MAX_PUSH_RETRIES,
  run, runSafe, refExists,
  getCurrentBranch, shadowBranchName,
  parseShadowIgnore, acquireLock, validateName, die,
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
  console.log('Usage: shadow-export.ts -m "Your commit message" [-r remote] [-d dir] [-b branch] [-n]');
  console.log("  -m  Commit message (required)");
  console.log("  -r  Remote name (selects config entry)    (default: first entry in REMOTES)");
  console.log("  -d  Local subdirectory to export from     (default: same as remote name)");
  console.log("  -b  Target branch                         (default: your current branch)");
  console.log("  -n  Dry run — show what would change without pushing");
  process.exit(values.help ? 0 : 1);
}

const dryRun = values["dry-run"] ?? false;
const commitMsg = values.message;

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.dirname(
  typeof __filename !== "undefined"
    ? __filename
    : new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);
const localBranch = getCurrentBranch();

const remoteEntry = values.remote
  ? REMOTES.find(r => r.remote === values.remote)
  : REMOTES[0];

if (values.remote && !remoteEntry) {
  die(`Remote '${values.remote}' not found in REMOTES. Add it to shadow-config.json.`);
}

const remote     = values.remote ?? remoteEntry!.remote;
const dir        = values.dir    ?? remoteEntry!.dir;
const externalBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");
const shadowBranch = shadowBranchName(dir, externalBranch);
const pushOrigin   = process.env.SHADOW_PUSH_ORIGIN ?? "origin";
const shadowRef    = `${pushOrigin}/${shadowBranch}`;

// Refuse to export if the local dir has uncommitted changes
const dirtyStaged   = !runSafe(["diff", "--cached", "--quiet", "--", `${dir}/`]).ok;
const dirtyUnstaged = !runSafe(["diff", "--quiet", "HEAD", "--", `${dir}/`]).ok;
if (dirtyStaged || dirtyUnstaged) {
  console.error(`\u2718 '${dir}/' has uncommitted changes:\n`);
  spawnSync("git", ["-c", "core.autocrlf=false", "status", "--short", "--", `${dir}/`], { stdio: "inherit" });
  console.error(`\nCommit or stash them before running shadow-export.`);
  process.exit(1);
}

acquireLock(SCRIPT_DIR, "shadow-export");

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Shadow branch : ${shadowBranch}`);
console.log();

// ── .shadowignore ─────────────────────────────────────────────────────────────

const ignorePatterns = parseShadowIgnore(SCRIPT_DIR);

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching latest from ${pushOrigin}...`);
run(["fetch", pushOrigin]);

if (!refExists(shadowRef)) {
  die(`Shadow branch '${shadowRef}' does not exist. Run shadow-setup.ts first.`);
}

// ── Worktree ──────────────────────────────────────────────────────────────────

const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-export-")).replace(/\\/g, "/");
const tempBranch  = `shadow-export-${Date.now()}`;
let   cleanupDone = false;

const cleanup = () => {
  if (cleanupDone) return;
  cleanupDone = true;
  runSafe(["worktree", "remove", "--force", worktreeDir]);
  runSafe(["branch", "-D", tempBranch]);
  fs.rmSync(worktreeDir, { recursive: true, force: true });
};

process.on("exit",    cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

run(["worktree", "add", "-b", tempBranch, worktreeDir, shadowRef]);

// ── Merge ─────────────────────────────────────────────────────────────────────
//
// Merge HEAD into the shadow branch with --no-commit so we can clean the
// index before committing.  -X theirs prefers our local (HEAD) changes on
// content conflicts.  The resulting commit is a real merge (two parents)
// but its tree never contains non-dir/ files or shadowignored files.

const headCommit = run(["rev-parse", "HEAD"]);
console.log(`Merging ${localBranch} (${headCommit.slice(0, 10)}) into shadow branch...`);

let mergeResult = runSafe(
  ["merge", "--no-commit", "--no-ff", "-X", "theirs", headCommit],
  worktreeDir,
);

if (!mergeResult.ok && mergeResult.stderr.includes("unrelated histories")) {
  console.log("  Histories are unrelated, retrying with --allow-unrelated-histories...");
  runSafe(["merge", "--abort"], worktreeDir);
  mergeResult = runSafe(
    ["merge", "--no-commit", "--no-ff", "-X", "theirs", "--allow-unrelated-histories", headCommit],
    worktreeDir,
  );
}

if (!mergeResult.ok) {
  // MERGE_HEAD should still exist — -X theirs resolves content conflicts,
  // but tree conflicts (modify/delete, rename/rename) may remain.
  if (!runSafe(["rev-parse", "MERGE_HEAD"], worktreeDir).ok) {
    console.error(mergeResult.stderr);
    die("Merge failed. Resolve conflicts manually and retry.");
  }

  // Auto-resolve any remaining tree conflicts in favour of HEAD (theirs)
  const unmerged = runSafe(["diff", "--name-only", "--diff-filter=U"], worktreeDir);
  if (unmerged.ok && unmerged.stdout) {
    for (const f of unmerged.stdout.split("\n").filter(Boolean)) {
      const co = runSafe(["checkout", "--theirs", "--", f], worktreeDir);
      if (co.ok) {
        run(["add", "--", f], worktreeDir);
      } else {
        // File was deleted on theirs side — accept the deletion
        runSafe(["rm", "--", f], worktreeDir);
      }
    }
  }
}

// ── Clean index ───────────────────────────────────────────────────────────────
//
// The merge brought in everything from HEAD (all dirs, config, scripts…).
// Strip the index back to only dir/ files, minus shadowignored patterns.
// Because MERGE_HEAD is still present, the eventual commit will record
// both parents — giving us real merge ancestry with a clean tree.

console.log(`Cleaning index (removing files outside '${dir}/' and shadowignored files)...`);

const allIndexed = run(["ls-files"], worktreeDir).split("\n").filter(Boolean);

// Remove anything not under dir/
const nonDirFiles = allIndexed.filter(f => !f.startsWith(`${dir}/`));
for (let i = 0; i < nonDirFiles.length; i += 100) {
  const batch = nonDirFiles.slice(i, i + 100);
  runSafe(["rm", "--cached", "-f", "--", ...batch], worktreeDir);
}

// Remove shadowignored files under dir/
if (ignorePatterns.length > 0) {
  const compiled = ignorePatterns.map(globToRegex);
  const dirFiles = run(["ls-files", "--", `${dir}/`], worktreeDir)
    .split("\n").filter(Boolean);
  const ignoredFiles = dirFiles.filter(f => {
    const rel = f.slice(dir.length + 1);
    return compiled.some(re => re.test(rel));
  });
  for (let i = 0; i < ignoredFiles.length; i += 100) {
    const batch = ignoredFiles.slice(i, i + 100);
    runSafe(["rm", "--cached", "-f", "--", ...batch], worktreeDir);
  }
}

// ── Commit & push ─────────────────────────────────────────────────────────────

const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"], worktreeDir).ok;
if (!hasStagedChanges) {
  console.log("No changes to export — shadow branch is already up to date.");
  cleanup();
  process.exit(0);
}

console.log("\nChanges to export:");
spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--cached", "--stat"], { cwd: worktreeDir, stdio: "inherit" });
console.log();

if (dryRun) {
  console.log("[DRY RUN] No changes were exported.");
  cleanup();
  process.exit(0);
}

const commitResult = spawnSync("git", ["-c", "core.autocrlf=false", "commit", "-m", commitMsg], {
  cwd: worktreeDir,
  encoding: "utf8",
  stdio: "inherit",
});
if (commitResult.error) die(`Failed to spawn git: ${commitResult.error.message}`);
if (commitResult.status !== 0) die("git commit failed in worktree.");

console.log(`Pushing to ${pushOrigin}/${shadowBranch}...`);

for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
  const pushResult = runSafe(["push", pushOrigin, `HEAD:${shadowBranch}`], worktreeDir);
  if (pushResult.ok) break;
  const isNonFF = pushResult.stderr.includes("non-fast-forward")
    || pushResult.stderr.includes("rejected")
    || pushResult.stderr.includes("fetch first");
  if (!isNonFF || attempt === MAX_PUSH_RETRIES) {
    console.error(pushResult.stderr);
    die(`git push failed after ${attempt} attempt(s).`);
  }
  console.log(`  Push rejected (non-fast-forward), retrying (${attempt}/${MAX_PUSH_RETRIES})...`);
  run(["fetch", pushOrigin]);
  if (refExists(`${pushOrigin}/${shadowBranch}`)) {
    const updatedRef = run(["rev-parse", `${pushOrigin}/${shadowBranch}`]);
    const rebaseResult = runSafe(["rebase", updatedRef], worktreeDir);
    if (!rebaseResult.ok) {
      die("Rebase onto updated shadow branch failed. Resolve manually and retry.");
    }
  }
}

cleanup();

console.log();
console.log(`\u2713 Done. Exported '${dir}/' \u2192 ${pushOrigin}/${shadowBranch} as: "${commitMsg}"`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
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
