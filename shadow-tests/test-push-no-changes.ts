import { createTestEnv, commitOnRemote, runPull, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("push-noop");
  try {
    // Sync state
    commitOnRemote(env, { "file.txt": "content\n" }, "Add file");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "pull should succeed");

    // Push without any local changes
    const r2 = runPush(env, "Nothing changed");
    assertEqual(r2.status, 0, "push should exit cleanly");
    assertIncludes(r2.stdout, "No changes to push", "should report no changes");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-no-changes");
}
