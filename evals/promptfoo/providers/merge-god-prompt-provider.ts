import { buildIssuePrompt, buildPrPrompt, buildReviewPrompt } from "../../../pr_prompt";

import type {
  ApiProvider,
  CallApiContextParams,
  ProviderOptions,
  ProviderResponse,
} from "promptfoo";

type Vars = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map((item) => asRecord(item)).filter((item) => Object.keys(item).length > 0)
    : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function renderMergeGodPrompt(vars: Vars): { promptKind: string; renderedPrompt: string } {
  const promptKind = asString(vars.prompt_kind || vars.kind);

  if (promptKind === "pr") {
    return {
      promptKind,
      renderedPrompt: buildPrPrompt(
        asRecord(vars.pr_details),
        asRecord(vars.pr_context),
        asString(vars.guidelines),
        asString(vars.commit_examples),
        asString(vars.merge_rules),
      ),
    };
  }

  if (promptKind === "issue") {
    return {
      promptKind,
      renderedPrompt: buildIssuePrompt({
        issueNumber: asNumber(vars.issue_number),
        title: asString(vars.title),
        url: asString(vars.url),
        body: asString(vars.body),
        branchName: asString(vars.branch_name),
        defaultBranch: asString(vars.default_branch),
        guidelines: asString(vars.guidelines),
        commitExamples: asString(vars.commit_examples),
        mergeRules: asString(vars.merge_rules),
      }),
    };
  }

  if (promptKind === "review") {
    return {
      promptKind,
      renderedPrompt: buildReviewPrompt(
        asNumber(vars.pr_number),
        asString(vars.title),
        asString(vars.head_branch),
        asString(vars.url),
        asString(vars.diff),
        asRecordArray(vars.changed_files),
        asString(vars.merge_rules),
      ),
    };
  }

  throw new Error(`Unsupported merge-god prompt kind: ${promptKind || "<missing>"}`);
}

function composeAgentPrompt(renderedPrompt: string, overlayPrompt: string): string {
  const overlay = overlayPrompt.trim();
  if (!overlay) {
    return renderedPrompt;
  }

  return [
    renderedPrompt,
    "",
    "---",
    "",
    "## Promptfoo Candidate Instructions",
    "",
    overlay,
    "",
  ].join("\n");
}

async function callUpstreamProvider(
  upstreamProviderId: string,
  prompt: string,
  context: CallApiContextParams | undefined,
  options: unknown,
  providerConfig: Record<string, unknown>,
): Promise<ProviderResponse> {
  const promptfoo = await import("promptfoo");
  const loadApiProvider = promptfoo.loadApiProvider as (
    id: string,
    options?: Record<string, unknown>,
  ) => Promise<ApiProvider>;
  const providerOptions =
    Object.keys(providerConfig).length > 0 ? { options: { config: providerConfig } } : undefined;
  const provider = await loadApiProvider(upstreamProviderId, providerOptions);
  return provider.callApi(prompt, context, options as never);
}

export default class MergeGodPromptProvider implements ApiProvider {
  private readonly providerId: string;
  private readonly config: Record<string, unknown>;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id || "merge-god-prompt-provider";
    this.config = options.config || {};
  }

  id(): string {
    return this.providerId;
  }

  async callApi(
    prompt: string,
    context?: CallApiContextParams,
    options?: unknown,
  ): Promise<ProviderResponse> {
    const vars = asRecord(context?.vars);
    const { promptKind, renderedPrompt } = renderMergeGodPrompt(vars);
    const dryRun = asBoolean(this.config.dryRun, true);
    const composedPrompt = composeAgentPrompt(renderedPrompt, prompt);
    const metadata = {
      prompt_kind: promptKind,
      rendered_prompt_chars: renderedPrompt.length,
      composed_prompt_chars: composedPrompt.length,
      dry_run: dryRun,
    };

    if (dryRun) {
      return {
        output: composedPrompt,
        prompt: composedPrompt,
        metadata,
        tokenUsage: {
          total: composedPrompt.length,
          prompt: composedPrompt.length,
          completion: 0,
        },
      };
    }

    const upstreamProviderId =
      process.env.MERGE_GOD_PROMPTFOO_PROVIDER ||
      asString(this.config.upstreamProvider) ||
      "openai:gpt-5-mini";
    const upstreamProviderConfig = asRecord(this.config.upstreamProviderConfig);
    const response = await callUpstreamProvider(
      upstreamProviderId,
      composedPrompt,
      context,
      options,
      upstreamProviderConfig,
    );
    return {
      ...response,
      prompt: composedPrompt,
      metadata: {
        ...asRecord(response.metadata),
        ...metadata,
        upstream_provider: upstreamProviderId,
      },
    };
  }
}
