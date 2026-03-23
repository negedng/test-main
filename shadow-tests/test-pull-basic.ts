import { createTestEnv, commitOnRemote, runPull, readLocalFile, getLocalLogFull } from "./harness";
import { assertEqual, assertIncludes, assertFileExists } from "./assert";

export default function run() {
  const env = createTestEnv("pull-basic");
  try {
    // Teammate makes two commits
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");
    commitOnRemote(env, { "utils.ts": "export const x = 1;\n" }, "Add utils.ts");

    // Pull them in
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "pull should succeed");
    assertIncludes(r1.stdout, "Mirrored", "should mirror commits");

    // Files exist locally
    assertEqual(readLocalFile(env, "app.ts"), "console.log('hello');\n", "app.ts content");
    assertEqual(readLocalFile(env, "utils.ts"), "export const x = 1;\n", "utils.ts content");

    // Commit messages have sync trailers
    const log = getLocalLogFull(env);
    assertIncludes(log, "Shadow-synced-from:", "should have sync trailer");

    // Re-run is a no-op
    const r2 = runPull(env);
    assertEqual(r2.status, 0, "second pull should succeed");
    assertIncludes(r2.stdout, "Already up to date", "should be up to date");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-basic");
}
