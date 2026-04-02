import { createTestEnv, commitOnRemote, commitOnLocal, runCiSync, mergeShadow, runPush, runCiForward, readShadowFile, getShadowLogFull, pullRemoteWorking, readRemoteFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/**
 * Verifies that a non-default shadowBranchPrefix (e.g. "shd") works
 * end-to-end: ci-sync pull, export, and ci-forward all use the configured
 * prefix instead of the hardcoded "shadow".
 */
export default function run() {
  const env = createTestEnv("custom-prefix", "frontend", "shd");
  try {
    // 1) Pull: external commit → ci-sync → shadow branch under "shd/" prefix
    commitOnRemote(env, { "hello.txt": "from external\n" }, "Add hello");
    const r1 = runCiSync(env);
    assertEqual(r1.status, 0, "ci-sync should succeed with custom prefix");
    assertIncludes(r1.stdout, "shd/frontend/main", "ci-sync output should reference custom prefix branch");
    mergeShadow(env);

    // Verify the file arrived locally
    assertEqual(
      readShadowFile(env, "hello.txt"),
      "from external\n",
      "hello.txt should be on the custom-prefix shadow branch",
    );

    // 2) Push: local commit → export → shadow branch under "shd/" prefix
    commitOnLocal(env, { "feature.ts": "export const x = 1;\n" }, "Add feature");
    const r2 = runPush(env, "Push feature");
    assertEqual(r2.status, 0, "export should succeed with custom prefix");
    assertIncludes(r2.stdout, "shd/frontend/main", "export output should reference custom prefix branch");

    assertEqual(
      readShadowFile(env, "feature.ts"),
      "export const x = 1;\n",
      "feature.ts should appear on the custom-prefix shadow branch",
    );

    // Export commit should have the export trailer
    const shadowLog = getShadowLogFull(env);
    assertIncludes(shadowLog, "Shadow-export:", "shadow commit should have export trailer");

    // 3) Forward: shadow branch → external remote
    const r3 = runCiForward(env);
    assertEqual(r3.status, 0, "ci-forward should succeed with custom prefix");
    assertIncludes(r3.stdout, "shd/frontend/main", "ci-forward output should reference custom prefix branch");

    pullRemoteWorking(env);
    assertEqual(
      readRemoteFile(env, "feature.ts"),
      "export const x = 1;\n",
      "feature.ts should arrive on the external remote",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-custom-branch-prefix");
}
