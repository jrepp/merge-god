#!/usr/bin/env node
/** Compatibility entrypoint for the canonical root CLI dispatcher. */

import { pathToFileURL } from "node:url";

import { main } from "../merge-god";

export { main } from "../merge-god";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
