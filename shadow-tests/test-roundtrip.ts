import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("roundtrip");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base\n" }, "Add base");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Push a local change
    commitOnLocal(env, { "local.txt": "from local\n" }, "Add local.txt");
    const r2 = runPush(env, "Push local.txt");
    assertEqual(r2.status, 0, "push should succeed");

    // Pull again — the pushed commit should be skipped (has Shadow-pushed-from trailer)
    const r3 = runPull(env);
    assertEqual(r3.status, 0, "pull after push should succeed");
    const output = r3.stdout;
    assertIncludes(output, "Skipped 1 commit(s) that originated from you", "should skip own push");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-roundtrip");
}
