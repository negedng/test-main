import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, getExternalShadowDiffFiles } from "./harness";
import { assertEqual } from "./assert";

/**
 * Test: replayed commits pushed to external repo show clean diffs —
 * only the changed file, no phantom deletions of monorepo-only files.
 */
export default function run() {
  const env = createTestEnv("push-diff-clean");
  try {
    // Bootstrap: sync external content so both sides agree
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial pull should succeed");
    mergeShadow(env);

    // Add a single file locally
    commitOnLocal(env, { "new.ts": "export const x = 1;\n" }, "Add new.ts");

    const r2 = runPush(env);
    assertEqual(r2.status, 0, "push should succeed");

    // The external shadow commit diff should only show the one file
    const files = getExternalShadowDiffFiles(env);
    assertEqual(files.length, 1, `expected 1 changed file, got: ${files.join(", ")}`);
    assertEqual(files[0], "new.ts", "diff should only show the added file (prefix stripped)");

    // Update an existing file locally
    commitOnLocal(env, { "base.txt": "updated base\n" }, "Update base.txt");

    const r3 = runPush(env);
    assertEqual(r3.status, 0, "second push should succeed");

    const files2 = getExternalShadowDiffFiles(env);
    assertEqual(files2.length, 1, `expected 1 changed file on update, got: ${files2.join(", ")}`);
    assertEqual(files2[0], "base.txt", "diff should only show the updated file");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-diff-clean");
}
