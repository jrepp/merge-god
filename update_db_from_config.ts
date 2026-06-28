#!/usr/bin/env node
/**
 * Update database with repository information from config.yaml.
 *
 * Ported from update_db_from_config.py.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import YAML from "yaml";

import { SyncStore } from "@merge-god/github-sync";

async function main(): Promise<number> {
  const configPath = "config.yaml";
  const dbPath = "merge-god-state.db";

  if (!existsSync(configPath)) {
    console.log(`❌ Config file not found: ${configPath}`);
    return 1;
  }

  console.log(`Loading config from: ${configPath}`);
  const parsed: unknown = YAML.parse(readFileSync(configPath, "utf8"));

  if (!parsed || typeof parsed !== "object" || !("repos" in parsed)) {
    console.log("❌ Invalid config: missing 'repos' section");
    return 1;
  }

  const repos = (parsed as Record<string, unknown>)["repos"];
  if (!Array.isArray(repos)) {
    console.log("❌ Invalid config: 'repos' is not a list");
    return 1;
  }

  console.log(`Updating database: ${dbPath}`);
  const db = new SyncStore(dbPath);
  await db.initialize();

  for (const item of repos) {
    const repoConfig =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};

    const enabledRaw = repoConfig["enabled"];
    const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);
    if (!enabled) {
      const name = (repoConfig["name"] as string | undefined) ?? "unknown";
      console.log(`  Skipping disabled repo: ${name}`);
      continue;
    }

    const repoPath = repoConfig["path"];
    if (typeof repoPath !== "string") {
      console.log("  ⚠️  Repository missing valid 'path'; skipping");
      continue;
    }

    const repoName = (repoConfig["name"] as string | undefined) ?? path.basename(repoPath);

    if (!existsSync(repoPath)) {
      console.log(`  ⚠️  Repository path not found: ${repoPath}`);
      continue;
    }

    const defaultBranch = "main";

    console.log(`  Adding repository: ${repoName}`);
    console.log(`    Path: ${repoPath}`);
    console.log(`    Default branch: ${defaultBranch}`);

    await db.saveRepository(repoName, repoPath, defaultBranch);
  }

  console.log("\n✅ Database updated successfully!");

  const stats = (await db.getStatistics()) as Record<string, unknown>;
  console.log("\nDatabase statistics:");
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key}: ${value}`);
  }

  db.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().then((code) => process.exit(code));
}
