import { createTestEnv, commitOnRemote, commitOnLocal, runPull, readLocalFile, resolveConflict } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

export default function run() {
  const env = createTestEnv("pull-conflict");
  try {
    // Teammate adds a file, pull it
    commitOnRemote(env, { "shared.txt": "line 1\nline 2\n" }, "Add shared.txt");
    const r1 = runPull(env);
    assertEqual(r1.status, 0, "first pull should succeed");

    // Local modifies the same file (divergence)
    commitOnLocal(env, { "shared.txt": "line 1\nline 2 modified locally\n" }, "Local edit");

    // Teammate also modifies the same lines
    commitOnRemote(env, { "shared.txt": "line 1\nline 2 modified by team\n" }, "Team edit");

    // Pull should hit a conflict
    const r2 = runPull(env);
    assertEqual(r2.status, 1, "pull should fail with conflict");
    const output = r2.stdout + r2.stderr;
    assertIncludes(output, "Merge conflict", "should report merge conflict");

    // Resolve the conflict and re-run
    resolveConflict(env, "shared.txt", "line 1\nline 2 merged\n");

    const r3 = runPull(env);
    assertEqual(r3.status, 0, "pull after resolution should succeed");
    assertIncludes(r3.stdout, "conflict resolved", "should report conflict resolved");

    // Verify final content
    assertEqual(readLocalFile(env, "shared.txt"), "line 1\nline 2 merged\n", "merged content");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-conflict");
}
