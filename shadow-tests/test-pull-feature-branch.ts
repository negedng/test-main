import { createTestEnv, commitOnRemote, runPull, readLocalFile } from "./harness";
import { assertEqual, assertIncludes } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull works on non-main branches. */
export default function run() {
  const env = createTestEnv("pull-feature-branch");
  try {
    // Teammate creates a feature branch and commits to it
    git("checkout -b feature/cool-thing", env.remoteWorking);
    fs.writeFileSync(path.join(env.remoteWorking, "cool.ts"), "export const cool = true;\n");
    git("add cool.ts", env.remoteWorking);
    git('commit -m "Add cool feature"', env.remoteWorking);
    git("push origin feature/cool-thing", env.remoteWorking);

    // Locally, create the same branch and pull from it
    git("checkout -b feature/cool-thing", env.localRepo);
    git(`fetch ${env.remoteName}`, env.localRepo);

    const r = runPull(env, ["-b", "feature/cool-thing"]);
    assertEqual(r.status, 0, "pull from feature branch should succeed");

    assertEqual(
      readLocalFile(env, "cool.ts"),
      "export const cool = true;\n",
      "feature file should be pulled",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-feature-branch");
}
