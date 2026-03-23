import { createTestEnv, commitOnRemote, runPull, readLocalFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";

/** Test: --dry-run shows what would be synced without applying changes. */
export default function run() {
  const env = createTestEnv("pull-dry-run");
  try {
    // Teammate makes a commit
    commitOnRemote(env, { "app.ts": "console.log('hello');\n" }, "Add app.ts");

    // Dry run — should list commit but not apply
    const r1 = runPull(env, ["-n"]);
    assertEqual(r1.status, 0, "dry-run pull should succeed");
    assertIncludes(r1.stdout, "DRY RUN", "should mention dry run");
    assertIncludes(r1.stdout, "Add app.ts", "should list the commit");

    // File should NOT exist locally
    assertEqual(readLocalFile(env, "app.ts"), null, "file should not be created in dry-run");

    // Real pull should still work after dry-run
    const r2 = runPull(env);
    assertEqual(r2.status, 0, "real pull should succeed");
    assertEqual(readLocalFile(env, "app.ts"), "console.log('hello');\n", "file should exist after real pull");
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-dry-run");
}
