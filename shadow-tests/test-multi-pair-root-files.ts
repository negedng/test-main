import { createTestEnv, addRemote, runCiSync, mergeShadow, runPush } from "./harness";
import { assertEqual } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFile(root: string, rel: string): string | null {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Test: monorepo with two pairs + root-level files.
 *
 *   A/main has:
 *     backend/    ←→ backend-repo (pair 1)
 *     frontend/   ←→ frontend-repo (pair 2)
 *     README.md   (root, not in any pair — must survive round-trip)
 *
 *   Scenario:
 *     1. A commits: adds backend/server.ts, frontend/app.tsx, README.md (v1)
 *     2. A pushes both pairs
 *     3. backend-repo sees only its backend/; merges shadow; adds its own edit
 *     4. frontend-repo sees only its frontend/; merges shadow; adds its own edit
 *     5. A edits README.md (v1 → v2) while the remotes work in parallel
 *     6. A pulls both pairs back
 *     7. A merges both shadow branches into main
 *     8. Assert:
 *          - backend/server.ts reflects B's edit
 *          - frontend/app.tsx reflects C's edit
 *          - README.md is STILL v2 — A's root-level edit survived the round-trip
 */
export default function run() {
  const env = createTestEnv("multi-pair-root-files", "frontend");
  const backend = addRemote(env, "backend", "backend");

  try {
    // 1. A commits backend/, frontend/, and a root README.md in ONE commit.
    //    (Monorepo developers routinely make cross-cutting changes in one commit.)
    writeFile(env.localRepo, "backend/server.ts", "app.listen(3000);\n");
    writeFile(env.localRepo, "frontend/app.tsx", "export default () => <div>A</div>;\n");
    writeFile(env.localRepo, "README.md", "README v1 — set by A\n");
    git("add -A", env.localRepo);
    git('commit -m "A: initial content for both pairs + root README"', env.localRepo);
    git("push origin main", env.localRepo);

    // 2. Push both pairs to their external remotes
    const rPushBackend = runPush(env, undefined, [], backend);
    assertEqual(rPushBackend.status, 0, "push backend pair should succeed");
    const rPushFrontend = runPush(env);
    assertEqual(rPushFrontend.status, 0, "push frontend pair should succeed");

    // 3. backend-repo: merge shadow, confirm isolation, add its own edit
    const backendShadow = `${env.branchPrefix}/${backend.subdir}/main`;
    git(`fetch origin ${backendShadow}`, backend.remoteWorking);
    git(`merge origin/${backendShadow} --no-ff -m "B: merge shadow"`, backend.remoteWorking);

    // Isolation: backend-repo should NOT have frontend files or root README
    assertEqual(
      fs.existsSync(path.join(backend.remoteWorking, "app.tsx")),
      false,
      "backend-repo must not see frontend/app.tsx",
    );
    assertEqual(
      fs.existsSync(path.join(backend.remoteWorking, "README.md")) &&
        fs.readFileSync(path.join(backend.remoteWorking, "README.md"), "utf8").includes("set by A"),
      false,
      "backend-repo must not see A's root README (though it may have its own)",
    );

    writeFile(backend.remoteWorking, "server.ts", "app.listen(3001); // B's port change\n");
    git("add server.ts", backend.remoteWorking);
    git('commit -m "B: change port"', backend.remoteWorking);
    git("push origin main", backend.remoteWorking);

    // 4. frontend-repo: merge shadow, confirm isolation, add its own edit
    const frontendShadow = `${env.branchPrefix}/${env.subdir}/main`;
    git(`fetch origin ${frontendShadow}`, env.remoteWorking);
    git(`merge origin/${frontendShadow} --no-ff -m "C: merge shadow"`, env.remoteWorking);

    assertEqual(
      fs.existsSync(path.join(env.remoteWorking, "server.ts")),
      false,
      "frontend-repo must not see backend/server.ts",
    );
    assertEqual(
      fs.existsSync(path.join(env.remoteWorking, "README.md")) &&
        fs.readFileSync(path.join(env.remoteWorking, "README.md"), "utf8").includes("set by A"),
      false,
      "frontend-repo must not see A's root README",
    );

    writeFile(env.remoteWorking, "app.tsx", "export default () => <div>C edited</div>;\n");
    git("add app.tsx", env.remoteWorking);
    git('commit -m "C: edit app"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // 5. A edits the root README while the remotes were doing their work
    writeFile(env.localRepo, "README.md", "README v2 — A edited post-push\n");
    git("add README.md", env.localRepo);
    git('commit -m "A: bump README to v2"', env.localRepo);
    git("push origin main", env.localRepo);

    // 6. A pulls both pairs back
    const rPullAll = runCiSync(env);
    assertEqual(rPullAll.status, 0, "pull back from both pairs should succeed");

    // 7. Merge both shadow branches into A/main
    mergeShadow(env);             // frontend
    mergeShadow(env, backend);    // backend

    // 8. Assertions
    assertEqual(
      readFile(env.localRepo, "backend/server.ts"),
      "app.listen(3001); // B's port change\n",
      "backend/server.ts should reflect B's edit",
    );
    assertEqual(
      readFile(env.localRepo, "frontend/app.tsx"),
      "export default () => <div>C edited</div>;\n",
      "frontend/app.tsx should reflect C's edit",
    );
    assertEqual(
      readFile(env.localRepo, "README.md"),
      "README v2 — A edited post-push\n",
      "README.md MUST still be v2 — A's root edit survived the round-trip",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-multi-pair-root-files");
}
