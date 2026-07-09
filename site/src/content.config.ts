import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({ pattern: "[a-z]*.md", base: "../docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    group: z.string().default("Guides"),
    order: z.number().default(0),
  }),
});

const rfcs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../docs-cms/rfcs" }),
  schema: z.object({
    title: z.string(),
    status: z.string(),
    author: z.string(),
    created: z.union([z.string(), z.date()]),
    updated: z.union([z.string(), z.date()]).optional(),
    tags: z.array(z.string()).default([]),
    id: z.string(),
    project_id: z.string(),
    doc_uuid: z.string(),
  }),
});

export const collections = { docs, rfcs };
