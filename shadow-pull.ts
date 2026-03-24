#!/usr/bin/env ts-node
import { parseArgs } from "util";
import * as path from "path";
import {
  REMOTES, SYNC_TRAILER, PUSH_TRAILER,
  run, runSafe, refExists, listTeamBranches,
  getCurrentBranch, getCommitMeta, diffForCommit,
  applyPatch, extractPatchFiles, commitWithMeta, appendTrailer,
  buildAlreadySyncedSetFor, collectTeamCommits, findSeedHash, findRemoteDefaultBranch,
  SEED_TRAILER,
  acquireLock, validateName, die, setSyncSince,
  preflightChecks, handlePreflightResults,
} from "./shadow-common";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    remote:  { type: "string",  short: "r" },
    dir:     { type: "string",  short: "d" },
    branch:  { type: "string",  short: "b" },
    since:   { type: "string",  short: "s" },
    seed:    { type: "boolean" },
    "dry-run": { type: "boolean", short: "n" },
    help:    { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: shadow-pull.ts [-r remote] [-d dir] [-b team-branch] [-s date] [-n] [--seed]");
  process.exit(0);
}

const dryRun = values["dry-run"] ?? false;
if (values.since !== undefined) setSyncSince(values.since || undefined);

// ── Setup ─────────────────────────────────────────────────────────────────────

const SCRIPT_DIR  = path.dirname(
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
const teamBranch = values.branch ?? localBranch;
validateName(remote, "Remote name");
validateName(dir, "Directory");
const teamRef    = `${remote}/${teamBranch}`;

acquireLock(SCRIPT_DIR, "shadow-pull");

console.log(`Remote        : ${remote}`);
console.log(`Local dir     : ${dir}/`);
console.log(`Local branch  : ${localBranch}`);
console.log(`Team branch   : ${teamBranch}`);
console.log();

// ── Fetch ─────────────────────────────────────────────────────────────────────

console.log(`Fetching from remote '${remote}'...`);
run(["fetch", remote]);

if (!refExists(teamRef)) {
  console.error(`✘ '${teamRef}' does not exist. Available branches on '${remote}':`);
  listTeamBranches(remote).forEach(b => console.error(`  ${b}`));
  process.exit(1);
}

// ── Pre-flight checks ────────────────────────────────────────────────────────

const warnings = preflightChecks(remote, teamRef);
if (!handlePreflightResults(warnings)) {
  process.exit(1);
}

// ── Seed mode ─────────────────────────────────────────────────────────────────

if (values.seed) {
  const tipHash = run(["rev-parse", teamRef]);
  const msg = appendTrailer(
    `Seed shadow-sync for ${dir}/ from ${teamRef}`,
    `${SEED_TRAILER}: ${dir} ${tipHash}`,
  );
  run(["commit", "--allow-empty", "-m", msg]);
  console.log(`✓ Seeded: future pulls for '${dir}/' will start after ${tipHash.slice(0, 10)}.`);
  process.exit(0);
}

// ── Determine which commits to apply ─────────────────────────────────────────

console.log("Scanning local history for already-mirrored commits...");
const alreadySynced = buildAlreadySyncedSetFor(dir);
console.log(`Found ${alreadySynced.size} previously mirrored commit(s).`);

const seedHash = findSeedHash(dir);
if (seedHash) {
  console.log(`Found seed baseline: ${seedHash.slice(0, 10)} (skipping earlier history).`);
}

const defaultBranch = findRemoteDefaultBranch(remote);
const isFeatureBranch = defaultBranch != null && teamBranch !== defaultBranch;
const baseRef = isFeatureBranch ? `${remote}/${defaultBranch}` : undefined;
if (baseRef) {
  console.log(`Feature branch detected: collecting only commits in ${baseRef}..${teamRef}`);
}

const allTeamCommits = collectTeamCommits(teamRef, { seedHash: seedHash ?? undefined, baseRef });

const newCommits: string[] = [];
let   skippedOurs = 0;

for (const hash of allTeamCommits) {
  if (alreadySynced.has(hash)) continue;

  const body = run(["log", "-1", "--format=%B", hash]);
  if (body.includes(`${PUSH_TRAILER}:`)) {
    skippedOurs++;
    continue;
  }

  newCommits.push(hash);
}

if (skippedOurs > 0) {
  console.log(`Skipped ${skippedOurs} commit(s) that originated from you (shadow-push).`);
}

if (newCommits.length === 0) {
  console.log("Already up to date. Nothing to mirror.");
  process.exit(0);
}

console.log(`Found ${newCommits.length} new commit(s) to mirror.`);

if (dryRun) {
  console.log("\n[DRY RUN] The following commits would be mirrored:\n");
  for (const hash of newCommits) {
    const meta = getCommitMeta(hash);
    console.log(`  ${meta.short}`);
  }
  console.log("\nNo changes were made.");
  process.exit(0);
}

console.log();

// ── Apply commits ─────────────────────────────────────────────────────────────

for (const hash of newCommits) {
  if (alreadySynced.has(hash)) continue;

  const meta = getCommitMeta(hash);

  const label = meta.parentCount > 1
    ? `merge commit ${meta.short} (diffing against first parent)`
    : meta.parentCount === 0
      ? `root commit ${meta.short}`
      : meta.short;

  console.log(`  Applying ${label}...`);

  const patch = diffForCommit(meta);
  const result = applyPatch(patch, dir);

  if (result !== "applied") {
    die(`Could not apply patch for ${meta.short}. Shadow branch may be out of sync.`);
  }

  const patchFiles = extractPatchFiles(patch, dir);
  if (patchFiles.length > 0) {
    run(["add", "--", ...patchFiles]);
  }

  const hasStagedChanges = !runSafe(["diff", "--cached", "--quiet"]).ok;
  const syncedMessage    = appendTrailer(meta.message, `${SYNC_TRAILER}: ${hash}`);

  if (!hasStagedChanges) {
    console.log("    (no changes after apply — recording as synced)");
    commitWithMeta(meta, syncedMessage, /* allowEmpty */ true);
    console.log("  ✓ Recorded (empty).");
    continue;
  }

  commitWithMeta(meta, syncedMessage);
  console.log("  ✓ Mirrored.");
}

console.log();
console.log(
  `Done. ${newCommits.length} commit(s) from '${remote}/${teamBranch}' mirrored into '${dir}/' on '${localBranch}'.`
);
