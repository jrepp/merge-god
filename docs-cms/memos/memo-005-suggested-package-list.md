---
title: Suggested TypeScript Package List
author: Engineering Team
created: 2026-07-16T00:00:00Z
tags: [cli, coordination, dependencies, typescript, validation]
id: memo-005
project_id: merge-god
doc_uuid: 1369c5d0-3ecb-4e68-b827-e10a0d2a7e9f
---

# Overview

Merge God should add libraries only where they remove repeated boundary code or
make side effects easier to control. The core orchestration and domain models
should remain plain TypeScript. This memo records the current package choices
and a short list to evaluate if the coordination HTTP server is rewritten.

# Adopted Packages

| Package | Boundary | Recommendation |
| --- | --- | --- |
| `commander` | Root CLI | Adopted. Use it for command registration, global options, dispatch, and generated help. Keep child CLIs isolated until they are migrated deliberately. |
| `execa` | Subprocess execution | Adopted behind `ExecutionPolicy`. Application orchestration should not import it directly. Native `spawn` remains appropriate for long-lived interactive processes that need a child handle. |
| `zod` | External input | Adopted for operator YAML and stable coordination request bodies. Schemas should stay at system boundaries rather than spreading through trusted internal models. |

# Coordination Server Candidates

| Package | Recommendation | Reason |
| --- | --- | --- |
| `hono` plus `@hono/node-server` | Preferred candidate | Small ESM-friendly routing layer with typed request helpers. It fits the local, narrow coordination API without requiring a broad application framework. |
| `fastify` | Strong alternative | Choose when schema-driven serialization, plugins, lifecycle hooks, or a larger HTTP surface justify the extra framework weight. |
| `@fastify/type-provider-zod` | Conditional | Add only if Fastify is selected and Zod schemas should drive route types and validation. |
| `pino` | Conditional | Add only if the coordination server needs a dedicated structured logger. Do not duplicate the existing telemetry and JSON event pipeline. |
| `undici` | Usually unnecessary | Node 22 already provides `fetch`. Add Undici directly only when its lower-level client, pooling, or test utilities are required. |

# Selection Guidance

Start a coordination rewrite with Hono and the existing Zod schemas. Compare it
with Fastify in a small spike if the proposed API needs plugins, response
serialization, or extensive route lifecycle hooks. Keep OpenTelemetry as the
observability standard and preserve `ExecutionPolicy` as the only owner of
ordinary subprocess execution.

Avoid adding a dependency-injection container. Constructor and function
injection are sufficient for the current process, telemetry, storage, and
coordination boundaries. A container would add indirection without removing
meaningful boilerplate at this scale.

# Upgrade Policy

Pin package major versions to the Node runtime declared in `package.json`.
Review engine requirements before upgrades, keep package changes focused, and
run the full application CI suite after each dependency update.

# References

- [Commander](https://github.com/tj/commander.js/)
- [Execa](https://github.com/sindresorhus/execa)
- [Zod](https://zod.dev/)
- [Hono on Node.js](https://hono.dev/docs/getting-started/nodejs)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
