/**
 * @merge-god/github-sync
 *
 * Async, multi-forge (GitHub / Gitea / Codeberg / GitLab) sync library.
 * Normalizes PR + branch + CI data onto shared models and persists to SQLite
 * for offline processing. This is merge-god's dedicated GitHub-integration
 * layer.
 *
 * Quick start:
 * ```ts
 * import { createForgeFromRepo, SyncStore, SyncEngine } from "@merge-god/github-sync";
 *
 * const store = new SyncStore("sync.db");
 * await store.initialize();
 * const { forge } = await createForgeFromRepo("/path/to/repo");
 * const engine = new SyncEngine(store, { forge });
 * const result = await engine.syncRepository("/path/to/repo");
 * ```
 */

// Models + factory fns + enums
export * from "./models";

// Forge abstraction
export {
  createForge,
  createForgeFromRepo,
  type CreateForgeFromRepoOptions,
  type Forge,
  type ForgeConfig,
  ForgeError,
  detectForge,
  detectForgeFromRepo,
  inferKindFromHost,
  type DetectOptions,
  GitHubForge,
  createGitHubForge,
  GiteaForge,
  createGiteaForge,
  GitLabForge,
  createGitLabForge,
} from "./forge";

// Git client
export { GitClient, GitClientError } from "./git-client";

// Store
export {
  SyncStore,
  DatabaseError,
  MigrationError,
  SCHEMA_VERSION,
  type PrContextForAgent,
} from "./store";

// Engine
export { SyncEngine, type SyncResult, type SyncProgress, type SyncEngineOptions } from "./engine";
