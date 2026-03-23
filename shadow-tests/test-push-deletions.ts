import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush, readRemoteFile, pullRemoteWorking } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("push-del");
  try {
    // Sync initial state with two files
    commitOnRemote(env, { "keep.txt": "keep\n", "remove.txt": "remove\n" }, "Add two files");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Delete one file locally
    commitOnLocal(env, { "remove.txt": null }, "Delete remove.txt");

    // Push
    const r2 = runPush(env, "Remove remove.txt");
    assertEqual(r2.status, 0, "push should succeed");

    // Verify remote
    pullRemoteWorking(env);
    assertEqual(readRemoteFile(env, "keep.txt"), "keep\n", "keep.txt should still exist");
    assertEqual(readRemoteFile(env, "remove.txt"), null, "remove.txt should be gone on remote");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-deletions");
}
