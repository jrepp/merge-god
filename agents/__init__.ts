/**
 * Agent abstraction layer for PR processing.
 *
 * Ported from agents/__init__.py. Re-exports public names from submodules so
 * callers can import from "agents" (e.g. `import { PRAgent } from "./agents"`).
 */

export * from "./callbacks";
export * from "./claude_agent";
