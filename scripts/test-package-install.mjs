import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "merge-god-package-"));

try {
  const packOutput = execFileSync("npm", ["pack", "--pack-destination", temporaryRoot, "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  const packResult = JSON.parse(packOutput)[0];
  if (!packResult?.filename) throw new Error("npm pack did not report a tarball");
  const tarball = join(temporaryRoot, basename(packResult.filename));
  const installRoot = join(temporaryRoot, "install");
  execFileSync("npm", ["install", "--prefix", installRoot, tarball], {
    cwd: root,
    stdio: "pipe",
  });
  const command = join(installRoot, "node_modules", ".bin", "merge-god");
  const help = execFileSync(command, ["help"], { encoding: "utf8" });
  if (!help.includes("repo") || !help.includes("pr") || !help.includes("resume")) {
    throw new Error("installed CLI help is missing primary workflows");
  }
  const installedPackage = JSON.parse(
    readFileSync(join(installRoot, "node_modules", "merge-god", "package.json"), "utf8"),
  );
  if (installedPackage.name !== "merge-god") throw new Error("installed package identity is incorrect");
  execFileSync(command, ["--db", join(temporaryRoot, "missing.db"), "status"], {
    cwd: temporaryRoot,
    stdio: "pipe",
  });
  const checkout = join(temporaryRoot, "checkout");
  mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet"], { cwd: checkout });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/repo.git"], { cwd: checkout });
  execFileSync(command, ["pr", "1", "--repo", "test-repo", "--dry-run"], {
    cwd: checkout,
    stdio: "pipe",
  });
  const nested = spawnSync(command, ["pr", "1", "--repo", "test-repo", "--no-sync"], {
    cwd: checkout,
    encoding: "utf8",
  });
  const nestedOutput = `${nested.stdout}${nested.stderr}`;
  if (nested.status !== 1 || !nestedOutput.includes("Database not found")) {
    throw new Error(`installed nested CLI did not reach the agent runner: ${nestedOutput}`);
  }
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", "await import('@merge-god/github-sync')"],
    {
      cwd: join(installRoot, "node_modules", "merge-god"),
      stdio: "pipe",
    },
  );
  console.log(`Installed and invoked ${installedPackage.name}@${installedPackage.version}`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
