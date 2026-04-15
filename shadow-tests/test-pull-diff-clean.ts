import { createTestEnv, commitOnRemote, runCiSync, getShadowDiffFiles } from "./harness";
import { assertEqual } from "./assert";

/**
 * Test: after initial sync, subsequent replayed commits show clean diffs —
 * only the changed file, no phantom additions/deletions from the full tree.
 */
export default function run() {
  const env = createTestEnv("pull-diff-clean");
  try {
    // Initial sync to establish baseline
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base.txt");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "initial ci-sync should succeed");

    // Second commit — add a single file
    commitOnRemote(env, { "feature.ts": "export const f = 1;\n" }, "Add feature.ts");
    const r2 = runCiSync(env);
    assertEqual(r2.status, 0, "second ci-sync should succeed");

    const files = getShadowDiffFiles(env);
    assertEqual(files.length, 1, `expected 1 changed file, got: ${files.join(", ")}`);
    assertEqual(files[0], `${env.subdir}/feature.ts`, "diff should only show the added file");

    // Third commit — modify the file
    commitOnRemote(env, { "feature.ts": "export const f = 2;\n" }, "Update feature.ts");
    const r3 = runCiSync(env);
    assertEqual(r3.status, 0, "third ci-sync should succeed");

    const files2 = getShadowDiffFiles(env);
    assertEqual(files2.length, 1, `expected 1 changed file on update, got: ${files2.join(", ")}`);
    assertEqual(files2[0], `${env.subdir}/feature.ts`, "diff should only show the updated file");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-diff-clean");
}
