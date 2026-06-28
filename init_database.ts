#!/usr/bin/env node
/**
 * Initialize the merge-god database (both the @merge-god/github-sync SyncStore
 * tables and the merge-god AppStore agent/session tables).
 */

import { pathToFileURL } from "node:url";
import { SyncStore } from "@merge-god/github-sync";
import { AppStore } from "./app_store";

async function main(): Promise<number> {
  const dbPath = "merge-god-state.db";

  console.log(`Creating database at: ${dbPath}`);
  const syncStore = new SyncStore(dbPath);
  await syncStore.initialize();
  const appStore = new AppStore(dbPath);
  console.log("✅ Database initialized successfully!");

  const stats = (await syncStore.getStatistics()) as Record<string, unknown>;
  console.log("\nDatabase statistics:");
  for (const [key, value] of Object.entries(stats)) {
    console.log(`  ${key}: ${value}`);
  }

  syncStore.close();
  appStore.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().then((code) => process.exit(code));
}
