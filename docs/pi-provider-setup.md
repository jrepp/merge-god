---
title: Pi provider setup
description: Configure the local embedded Pi agent and onboard model providers for merge-god.
group: Guides
order: 14
---

merge-god launches the local `pi` command for each agent run and injects its
coordination extension automatically. Provider credentials, the default
provider, and the default model are owned by Pi rather than `config.yaml`.

## 1. Locate Pi's configuration

Pi reads global configuration from `~/.pi/agent` by default:

| File | Purpose |
| --- | --- |
| `settings.json` | Selects the default provider, model, and thinking level |
| `models.json` | Adds custom providers and models |
| `auth.json` | Pi-managed credentials; treat this file as sensitive |

Set `PI_CODING_AGENT_DIR` before starting merge-god to use another directory.
Project-specific Pi settings can also live in `.pi/settings.json`.

## 2. Configure a built-in provider

Export the provider's credential in the environment that starts merge-god.
For example:

```bash
export ANTHROPIC_API_KEY="..."
pi --list-models anthropic
```

Then merge these defaults into `~/.pi/agent/settings.json`, using a model ID
reported by `pi --list-models`:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "MODEL_ID_FROM_PI",
  "defaultThinkingLevel": "high"
}
```

Pi supports other built-in providers through their corresponding environment
variables, such as `OPENAI_API_KEY`, `GEMINI_API_KEY`, or
`OPENROUTER_API_KEY`. `pi --help` lists the credentials supported by the
installed Pi version.

## 3. Add a compatible provider

For an internal gateway or local model server, add the provider to
`~/.pi/agent/models.json`. This example keeps the secret in an environment
variable rather than JSON:

```json
{
  "providers": {
    "company-gateway": {
      "baseUrl": "https://llm.example.com/v1",
      "api": "openai-completions",
      "apiKey": "COMPANY_LLM_API_KEY",
      "models": [
        {
          "id": "company-coder",
          "name": "Company Coder",
          "reasoning": true,
          "contextWindow": 128000,
          "maxTokens": 16384,
          "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false
          }
        }
      ]
    }
  }
}
```

Export `COMPANY_LLM_API_KEY`, then select `company-gateway` and
`company-coder` in `settings.json`. Supported API adapters include
`openai-completions`, `openai-responses`, `anthropic-messages`, and
`google-generative-ai`.

The `apiKey` value may be an environment variable name or a command prefixed
with `!` that prints a credential. Do not commit literal credentials. Providers
that require a custom wire protocol or OAuth flow need a Pi provider extension
instead of a `models.json` entry.

## 4. Verify the provider

First verify Pi can discover the provider and complete a real request:

```bash
pi --list-models company-gateway
pi --provider company-gateway --model company-coder \
  --print "Reply with exactly: provider-ok"
```

Then verify merge-god's local prerequisites and inspect a PR plan without
starting the agent:

```bash
merge-god doctor
merge-god pr 123 --dry-run
```

`merge-god doctor` verifies that `pi` is installed; the direct `pi --print`
request is what verifies provider authentication and model access. Once both
checks pass, run a labelled test PR through `merge-god pr 123` for an end-to-end
check.

## Environment note

Pi inherits the environment of the merge-god process, so credentials exported
only in an interactive shell will not automatically reach a service, cron job,
or terminal multiplexer started elsewhere. Configure credentials where
merge-god itself is launched.

The target repository's `.env` file is not a general Pi credential loader.
merge-god currently imports only `ZAI_API_KEY` from that file. Export all other
provider variables in the parent environment or use Pi's credential files and
key-command support.
