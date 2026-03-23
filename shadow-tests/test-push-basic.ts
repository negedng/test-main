import { createTestEnv, commitOnRemote, commitOnLocal, runPull, runPush, readRemoteFile, pullRemoteWorking, getLocalLogFull } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("push-basic");
  try {
    // Sync initial state
    commitOnRemote(env, { "base.txt": "base content\n" }, "Add base.txt");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "initial pull should succeed");

    // Add a file locally and commit
    commitOnLocal(env, { "new-feature.ts": "export function feat() {}\n" }, "Add new feature");

    // Push to remote
    const r2 = runPush(env, "Add new feature from mono-repo");
    assertEqual(r2.status, 0, "push should succeed");
    assertIncludes(r2.stdout, "Done", "should report done");

    // Verify on the remote side
    pullRemoteWorking(env);
    assertEqual(
      readRemoteFile(env, "new-feature.ts"),
      "export function feat() {}\n",
      "new-feature.ts should appear on remote",
    );

    // Remote commit should have push trailer
    const { execSync } = require("child_process");
    const remoteLog = execSync("git log -1 --format=%B", {
      cwd: env.remoteWorking,
      encoding: "utf8",
    }).trim();
    assertIncludes(remoteLog, "Shadow-pushed-from:", "remote commit should have push trailer");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-push-basic");
}
