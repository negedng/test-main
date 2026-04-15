import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Test: file rename detection during push.
 *
 * When a file is renamed in the source, git diff-tree reports status "R".
 * The replay engine should remove the old path and add the new path on the
 * target side, with both paths prefix-remapped.
 */
export default function run() {
  const env = createTestEnv("push-rename");
  try {
    // 1. Establish baseline with a file
    commitOnRemote(env, { "old-name.ts": "content to rename\n" }, "Add old-name.ts");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    mergeShadow(env);

    // Verify initial state
    const localFile = path.join(env.localRepo, env.subdir, "old-name.ts");
    assertEqual(fs.existsSync(localFile), true, "old-name.ts should exist locally after merge");

    // 2. Rename the file locally using git mv (so git detects it as a rename)
    git(`mv ${env.subdir}/old-name.ts ${env.subdir}/new-name.ts`, env.localRepo);
    git('commit -m "Rename old-name.ts to new-name.ts"', env.localRepo);

    // 3. Push to B
    const r2 = runPush(env);
    assertEqual(r2.status, 0, "push with rename should succeed");

    // 4. On the external shadow branch, old file should be gone, new file should exist
    assertEqual(
      readExternalShadowFile(env, "new-name.ts"),
      "content to rename\n",
      "new-name.ts should exist on shadow branch with original content",
    );
    assertEqual(
      readExternalShadowFile(env, "old-name.ts"),
      null,
      "old-name.ts should NOT exist on shadow branch (was renamed)",
    );

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-rename");
}
