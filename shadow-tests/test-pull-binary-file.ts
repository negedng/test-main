import { createTestEnv, runPull } from "./harness";
import { assertEqual, assertFileExists } from "./assert";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Test: pull handles binary files (e.g., a small PNG). */
export default function run() {
  const env = createTestEnv("pull-binary-file");
  try {
    // Create a small binary file on the remote (a minimal valid PNG)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8-bit RGB
      0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
      0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00,
      0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33,
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
      0xAE, 0x42, 0x60, 0x82,
    ]);

    const remotePng = path.join(env.remoteWorking, "icon.png");
    fs.writeFileSync(remotePng, pngHeader);
    git("add icon.png", env.remoteWorking);
    git('commit -m "Add binary PNG"', env.remoteWorking);
    git("push origin main", env.remoteWorking);

    // Pull it
    const r = runPull(env);
    assertEqual(r.status, 0, "pull with binary file should succeed");

    // Verify binary file exists and has correct size
    const localPng = path.join(env.localRepo, env.subdir, "icon.png");
    assertFileExists(localPng, "binary file should exist locally");

    const localContent = fs.readFileSync(localPng);
    assertEqual(localContent.length, pngHeader.length, "binary file size should match");
    assertEqual(
      Buffer.compare(localContent, pngHeader) === 0,
      true,
      "binary file content should match exactly",
    );
  } finally {
    env.cleanup();
  }
}

if (require.main === module) {
  run();
  console.log("PASS  test-pull-binary-file");
}
