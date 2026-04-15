import { createTestEnv, runCiSync } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: stale shadow branch detection.
 *
 * When a source branch is deleted but its shadow branch still exists on the
 * target, the tool should warn about it and print a cleanup command.
 *
 * Note: the tool does `git fetch` without --prune, so we must prune
 * the local tracking refs before running sync for stale detection to work.
 */
export default function run() {
  const env = createTestEnv("stale-branch");
  try {
    // 1. Create a feature branch on the remote and push it
    git("checkout -b feature/temp", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "temp.ts"), "temporary\n");
    git("add temp.ts", env.remoteWorking);
    git('commit -m "Add temp feature"', env.remoteWorking);
    git("push origin feature/temp", env.remoteWorking);
    git("checkout main", env.remoteWorking);

    // 2. Sync — should create shadow/frontend/feature/temp on origin
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial sync should succeed");

    // Verify the feature shadow branch was created
    git("fetch origin", env.localRepo);
    const branches1 = git("branch -r", env.localRepo);
    assertEqual(
      branches1.includes(`origin/${env.branchPrefix}/${env.subdir}/feature/temp`),
      true,
      "feature shadow branch should exist after sync",
    );

    // 3. Delete the feature branch on the remote
    git("push origin --delete feature/temp", env.remoteWorking);

    // Prune local tracking refs so the deleted branch disappears from `branch -r`
    git(`fetch ${env.remoteName} --prune`, env.localRepo);

    // 4. Sync again — should warn about stale shadow branch
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "sync after branch deletion should succeed");
    assertIncludes(r2.stdout, "Stale shadow branch", "should warn about stale branch");
    assertIncludes(r2.stdout, "feature/temp", "warning should mention the deleted branch");
    assertIncludes(r2.stdout, "--delete", "should suggest cleanup command");

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-stale-branch-warning");
}
