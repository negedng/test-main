import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: echo commits resolve to their original target-side hash, not the
 * target's current branch tip via fallback.
 *
 * Scenario from the diagram (B-side has a commit BEFORE the merge):
 *   A/main:  init --- b
 *   B/main:  seed --- a --- merge(a, b') --- c
 *
 * When syncing B → A, the merge's second parent (b', an echo of A's `b`)
 * must resolve to the original `b` commit hash on A — not to whatever
 * A/main's tip happens to be. This keeps A/main and shadow/B/main sharing
 * the real `b` commit as their merge-base.
 */
export default function run() {
  const env = createTestEnv("pull-echo-mapping");
  try {
    // 1. Establish baseline — seed B with something then pull to create the shadow branch
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    mergeShadow(env);

    // 2. A commits `b` locally (origin side)
    commitOnLocal(env, { "from-a.ts": "A's work\n" }, "b: add from-a.ts");
    const hashB = git("rev-parse HEAD", env.localRepo);

    // 3. Push A → B (creates b' on team/shadow/frontend/main with trailer)
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "push A→B should succeed");

    // 4. On B side: commit `a` on main BEFORE the merge, then merge b' in,
    //    then commit `c` after the merge.
    const shadowBranch = `${env.branchPrefix}/${env.subdir}/main`;
    fs.writeFileSync(path.join(env.remoteWorking, "b-pre.ts"), "B before merge\n");
    git("add b-pre.ts", env.remoteWorking);
    git('commit -m "a: B commit before merge"', env.remoteWorking);

    git(`fetch origin ${shadowBranch}`, env.remoteWorking);
    git(`merge origin/${shadowBranch} --no-ff -m "merge shadow into B main"`, env.remoteWorking);

    fs.writeFileSync(path.join(env.remoteWorking, "b-post.ts"), "B after merge\n");
    git("add b-post.ts", env.remoteWorking);
    git('commit -m "c: B commit after merge"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // 5. Advance A/main past `b` — simulates A moving on before the next sync.
    //    This is the case where the old fallback-to-tip logic would wire
    //    the replayed merge's parent to this new tip instead of `b`.
    commitOnLocal(env, { "a-after.ts": "A keeps going\n" }, "A: post-b work");
    const hashAfterB = git("rev-parse HEAD", env.localRepo);

    // 6. Pull B → A. The echo of b' should map back to `b` (not to hashAfterB).
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "pull B→A should succeed");

    // 7. Verify: origin/shadow/frontend/main contains the ORIGINAL `b` commit
    //    in its ancestry — reachable via the replayed merge's second parent.
    git(`fetch origin ${shadowBranch}`, env.localRepo);
    const shadowTip = git(`rev-parse origin/${shadowBranch}`, env.localRepo);
    const ancestors = git(`rev-list ${shadowTip}`, env.localRepo).split("\n");
    assertIncludes(
      ancestors.join("\n"),
      hashB,
      "original `b` hash must appear in shadow branch ancestry (echo mapped to original, not fallback)",
    );

    // And it must NOT wire to the post-b tip — that'd mean the fallback leaked
    // through and the replayed merge claims to have merged later A work.
    assertEqual(
      ancestors.includes(hashAfterB),
      false,
      "post-b tip must not appear in shadow ancestry (would indicate fallback, not trailer lookup)",
    );

    // 8. Sanity: A/main can fast-forward to shadow tip, since `b` is a shared
    //    commit and A's post-b work also descends from it. We expect a
    //    non-conflicting merge (merge-base = b or later).
    const mergeBase = git(`merge-base HEAD origin/${shadowBranch}`, env.localRepo);
    assertEqual(
      mergeBase === hashB || mergeBase === hashAfterB,
      true,
      `merge-base should be b or a descendant of b (got ${mergeBase.slice(0, 10)})`,
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-echo-mapping");
}
