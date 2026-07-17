import { z } from "zod";

export const repositoryConfigSchema = z.looseObject({
  path: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  watch_issues: z.boolean().optional(),
  interactive: z.boolean().optional(),
});

export const operatorConfigSchema = z.looseObject({
  repos: z.array(repositoryConfigSchema),
});

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
export type OperatorConfig = z.infer<typeof operatorConfigSchema>;

export function parseOperatorConfig(input: unknown): OperatorConfig {
  const result = operatorConfigSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid operator config:\n${z.prettifyError(result.error)}`);
  return result.data;
}
