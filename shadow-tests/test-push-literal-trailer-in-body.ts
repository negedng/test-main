import { createTestEnv, commitOnLocal, runPush, readExternalShadowFile } from "./harness";
import { assertEqual } from "./assert";

/**
 * Test: a commit whose message contains the skip-trailer text literally
 * (e.g. as a reference in the subject or body) must NOT be treated as an
 * echo and silently dropped. The trailer check must be line-anchored.
 *
 * With the substring check, the commit is filtered out of newCommits and
 * never reaches the shadow branch.
 */
export default function run() {
  const env = createTestEnv("push-literal-trailer-in-body");
  try {
    // The literal "Shadow-replayed-team:" text here is just a reference
    // in the subject — not a real trailer (not on its own line at the end).
    commitOnLocal(
      env,
      { "feature.ts": "export const x = 1;\n" },
      `Refactor referencing Shadow-replayed-${env.remoteName}: abc1234`,
    );

    const r = runPush(env);
    assertEqual(r.status, 0, "push should succeed");

    assertEqual(
      readExternalShadowFile(env, "feature.ts"),
      "export const x = 1;\n",
      "file should reach shadow branch despite literal trailer text in subject",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-literal-trailer-in-body");
}
