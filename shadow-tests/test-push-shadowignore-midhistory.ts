import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";

/**
 * Test: .shadowignore added mid-history takes effect immediately.
 *
 * The ignore file is auto-discovered per commit from the source tree.
 * Adding a .shadowignore in a later commit should filter files from that
 * commit onward, without needing any config change.
 */
export default function run() {
  const env = createTestEnv("shadowignore-mid");
  try {
    // 1. Establish baseline
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    mergeShadow(env);

    // 2. First push: both files should go through (no .shadowignore yet)
    commitOnLocal(env, {
      "visible.ts": "should sync\n",
      "secret.local": "should not sync later\n",
    }, "Add visible.ts and secret.local");

    const r2 = runPush(env);
    assertEqual(r2.status, 0, "first push should succeed");
    assertEqual(readExternalShadowFile(env, "visible.ts"), "should sync\n", "visible.ts should be on shadow");
    assertEqual(readExternalShadowFile(env, "secret.local"), "should not sync later\n", "secret.local should be on shadow (no ignore yet)");

    // 3. Add .shadowignore that excludes *.local files, and modify the ignored file
    commitOnLocal(env, {
      ".shadowignore": "**/*.local\n",
      "secret.local": "updated secret\n",
      "another.ts": "also visible\n",
    }, "Add .shadowignore and update files");

    const r3 = runPush(env);
    assertEqual(r3.status, 0, "push with new .shadowignore should succeed");

    // 4. another.ts should appear, but secret.local should NOT be updated
    assertEqual(readExternalShadowFile(env, "another.ts"), "also visible\n", "another.ts should be on shadow");
    // secret.local should still have the old content (the update was ignored)
    assertEqual(
      readExternalShadowFile(env, "secret.local"),
      "should not sync later\n",
      "secret.local should NOT be updated (blocked by .shadowignore)",
    );

  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-shadowignore-midhistory");
}
