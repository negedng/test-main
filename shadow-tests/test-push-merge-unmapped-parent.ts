import { createTestEnv, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: a merge commit with an unmapped first parent (e.g. a merge of an
 * orphan branch with --allow-unrelated-histories, where the main-side
 * parent is the seed commit itself and therefore not in shaMapping) must
 * still produce a 2-parent commit on the shadow branch, not be silently
 * collapsed to a single parent.
 */
export default function run() {
  const env = createTestEnv("push-merge-unmapped-parent");
  try {
    const sub = env.subdir;

    // Capture the external seed tip — we expect this to be grafted in as
    // the unmapped-parent fallback on the replayed merge.
    const seedTip = git(`rev-parse ${env.remoteName}/main`, env.localRepo);

    // Create an orphan branch with unrelated history
    git("checkout --orphan orphan", env.localRepo);
    git("rm -rf --cached .", env.localRepo);
    // working tree still has files; clear and start fresh
    for (const f of fs.readdirSync(env.localRepo)) {
      if (f === ".git") continue;
      fs.rmSync(path.join(env.localRepo, f), { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(env.localRepo, sub), { recursive: true });
    fs.writeFileSync(path.join(env.localRepo, sub, "orphan.ts"), "from orphan\n");
    git(`add ${sub}/orphan.ts`, env.localRepo);
    git(`commit -m "C_orphan on unrelated branch"`, env.localRepo);

    // Back to main, merge orphan with unrelated histories
    git("checkout main", env.localRepo);
    git("merge --allow-unrelated-histories --no-commit --no-ff orphan", env.localRepo);
    // Amend subdir content during merge so merge commit survives path-filter
    fs.writeFileSync(path.join(env.localRepo, sub, "merge-marker.ts"), "merge marker\n");
    git(`add ${sub}/merge-marker.ts`, env.localRepo);
    git(`commit -m "C_merge bring orphan into main"`, env.localRepo);

    const r = runPush(env);
    assertEqual(r.status, 0, "push should succeed");

    const shadowBranch = `${env.branchPrefix}/${sub}/main`;
    git(`fetch ${env.remoteName} ${shadowBranch}`, env.localRepo);
    const parentLine = git(
      `log -1 --format=%P ${env.remoteName}/${shadowBranch}`,
      env.localRepo,
    );
    const parents = parentLine.split(/\s+/).filter(Boolean);
    assertEqual(
      parents.length,
      2,
      `replayed merge should have 2 parents, got ${parents.length} (${parentLine})`,
    );
    // First parent (the main-side / unmapped parent) should be the external
    // seed tip, not the current external main tip or a dropped parent.
    assertEqual(
      parents[0],
      seedTip,
      "unmapped parent should be grafted onto the external seed tip",
    );

    // Content from both the orphan commit and the merge amendment must
    // appear on the shadow branch (prefix stripped).
    assertEqual(
      readExternalShadowFile(env, "orphan.ts"),
      "from orphan\n",
      "orphan.ts should be on shadow branch",
    );
    assertEqual(
      readExternalShadowFile(env, "merge-marker.ts"),
      "merge marker\n",
      "merge-marker.ts should be on shadow branch",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-merge-unmapped-parent");
}
