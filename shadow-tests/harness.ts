import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface TestEnv {
  tmpDir: string;
  localRepo: string;
  remoteWorking: string;
  remoteBare: string;
  subdir: string;
  remoteName: string;
  cleanup: () => void;
}

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Create an isolated test environment with three git repos. */
export function createTestEnv(name: string, subdir = "frontend"): TestEnv {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `shadow-test-${name}-`));
  const remoteBare = path.join(tmpDir, "remote-bare").replace(/\\/g, "/");
  const remoteWorking = path.join(tmpDir, "remote-working").replace(/\\/g, "/");
  const localRepo = path.join(tmpDir, "local").replace(/\\/g, "/");
  const remoteName = "team";

  // 1) Bare remote
  fs.mkdirSync(remoteBare);
  git("init --bare", remoteBare);

  // 2) Working clone of remote — create initial commit so branch exists
  execSync(`git clone "${remoteBare}" "${remoteWorking}"`, { encoding: "utf8", stdio: "pipe" });
  git('config user.email "team@test.com"', remoteWorking);
  git('config user.name "Team Member"', remoteWorking);
  fs.writeFileSync(path.join(remoteWorking, "README.md"), "# Remote Repo\n");
  git("add -A", remoteWorking);
  git('commit -m "Initial commit"', remoteWorking);
  git("push origin main", remoteWorking);

  // 3) Local mono-repo
  fs.mkdirSync(localRepo);
  git("init", localRepo);
  git('config user.email "local@test.com"', localRepo);
  git('config user.name "Local Dev"', localRepo);
  // Create initial commit (subdir is created later by pull/local commits)
  fs.writeFileSync(path.join(localRepo, "mono.txt"), "mono-repo root\n");
  fs.mkdirSync(path.join(localRepo, subdir), { recursive: true });
  git("add -A", localRepo);
  git('commit -m "Initial mono-repo commit"', localRepo);
  // Add remote
  git(`remote add ${remoteName} "${remoteBare}"`, localRepo);
  git(`fetch ${remoteName}`, localRepo);

  // Copy shadow scripts into local repo so they run from there
  const scriptDir = path.resolve(__dirname, "..");
  for (const f of ["shadow-common.ts", "shadow-pull.ts", "shadow-push.ts"]) {
    fs.copyFileSync(path.join(scriptDir, f), path.join(localRepo, f));
  }

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, localRepo, remoteWorking, remoteBare, subdir, remoteName, cleanup };
}

/** Commit files on the remote (simulates a teammate). null value = delete. */
export function commitOnRemote(
  env: TestEnv,
  files: Record<string, string | null>,
  message: string,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(env.remoteWorking, rel);
    if (content === null) {
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        git(`rm "${rel}"`, env.remoteWorking);
      }
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      git(`add "${rel}"`, env.remoteWorking);
    }
  }
  git(`commit -m "${message}"`, env.remoteWorking);
  git("push origin main", env.remoteWorking);
}

/** Commit files in the local repo under the subdir. null value = delete. */
export function commitOnLocal(
  env: TestEnv,
  files: Record<string, string | null>,
  message: string,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(env.localRepo, env.subdir, rel);
    if (content === null) {
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        git(`rm "${env.subdir}/${rel}"`, env.localRepo);
      }
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      git(`add "${env.subdir}/${rel}"`, env.localRepo);
    }
  }
  git(`commit -m "${message}"`, env.localRepo);
}

/** Normalize line endings to LF (Windows git may use CRLF). */
function normalizeLF(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/** Read a file from the local repo's subdir. Returns null if absent. */
export function readLocalFile(env: TestEnv, rel: string): string | null {
  const full = path.join(env.localRepo, env.subdir, rel);
  if (!fs.existsSync(full)) return null;
  return normalizeLF(fs.readFileSync(full, "utf8"));
}

/** Read a file from the remote working copy. Returns null if absent. */
export function readRemoteFile(env: TestEnv, rel: string): string | null {
  const full = path.join(env.remoteWorking, rel);
  if (!fs.existsSync(full)) return null;
  return normalizeLF(fs.readFileSync(full, "utf8"));
}

/** Get local repo commit log (one-line messages). */
export function getLocalLog(env: TestEnv, n = 20): string {
  return git(`log --oneline -${n}`, env.localRepo);
}

/** Get local repo full commit messages. */
export function getLocalLogFull(env: TestEnv, n = 20): string {
  return git(`log --format="%B" -${n}`, env.localRepo);
}

/** Build env vars for running shadow scripts in test mode. */
function testEnv(env: TestEnv): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    SHADOW_TEST_REMOTE: env.remoteName,
    SHADOW_TEST_DIR: env.subdir,
    SHADOW_TEST_SINCE: "",  // no date filter in tests
  };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Shell-escape a string for use in a command. */
function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/**
 * Run a shadow script in the test env.
 * Uses the node binary + tsx loader from the current process to avoid
 * npx resolution issues when cwd is a temp directory.
 */
function runScript(env: TestEnv, script: string, args: string[]): RunResult {
  const scriptPath = path.join(env.localRepo, script).replace(/\\/g, "/");
  const parts = [shellQuote(scriptPath), ...args.map(shellQuote)];
  // Use npx tsx with the original project dir in PATH so npx can find tsx
  const projectDir = path.resolve(__dirname, "..").replace(/\\/g, "/");
  const cmd = `npx --prefix ${shellQuote(projectDir)} tsx ${parts.join(" ")}`;
  const result = spawnSync(cmd, {
    cwd: env.localRepo,
    env: testEnv(env),
    encoding: "utf8",
    shell: true,
    timeout: 30000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run shadow-pull.ts in the test env. */
export function runPull(env: TestEnv, extraArgs: string[] = []): RunResult {
  return runScript(env, "shadow-pull.ts", ["-r", env.remoteName, ...extraArgs]);
}

/** Run shadow-push.ts in the test env. */
export function runPush(env: TestEnv, message: string, extraArgs: string[] = []): RunResult {
  return runScript(env, "shadow-push.ts", ["-r", env.remoteName, "-m", message, ...extraArgs]);
}

/** Pull latest from bare remote into the remote working copy. */
export function pullRemoteWorking(env: TestEnv): void {
  git("pull origin main", env.remoteWorking);
}

/** Resolve conflicts in local repo by writing file content and staging. */
export function resolveConflict(env: TestEnv, rel: string, content: string): void {
  const full = path.join(env.localRepo, env.subdir, rel);
  fs.writeFileSync(full, content);
  git(`add "${env.subdir}/${rel}"`, env.localRepo);
}
