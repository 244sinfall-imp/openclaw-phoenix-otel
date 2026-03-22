# OpenClaw Phoenix OTEL Plugin

Export full agent traces (prompts, responses, tool calls, sub-agents) from [OpenClaw](https://openclaw.ai) to [Phoenix (Arize)](https://phoenix.arize.com) via OpenTelemetry.

## What it captures

- **LLM interactions**: prompts, system prompts, responses, token usage
- **Tool calls**: tool name, input parameters, output/errors
- **Sub-agent lifecycle**: spawn, execution, completion
- **Cost metadata**: USD cost, context window usage
- **Span hierarchy**: root AGENT span → child LLM/TOOL/AGENT spans

All data uses [OpenInference semantic conventions](https://github.com/Arize-ai/openinference) for native Phoenix integration.

## Install

```bash
openclaw plugins install /path/to/openclaw-phoenix-otel
# or from GitHub:
openclaw plugins install https://github.com/exiao/openclaw-phoenix-otel
```

## Configure

Add to your OpenClaw config (`~/.openclaw/config.json`):

```json
{
  "plugins": {
    "entries": {
      "phoenix-otel": {
        "enabled": true,
        "config": {
          "endpoint": "https://app.phoenix.arize.com",
          "apiKey": "<your-phoenix-api-key>",
          "projectName": "openclaw",
          "serviceName": "openclaw"
        }
      }
    }
  }
}
```

### Config options

| Option | Env var | Default | Description |
|--------|---------|---------|-------------|
| `endpoint` | `PHOENIX_HOST` | `https://app.phoenix.arize.com` | Phoenix instance URL |
| `apiKey` | `PHOENIX_API_KEY` | — | Phoenix API key |
| `projectName` | `PHOENIX_PROJECT_NAME` | `openclaw` | Phoenix project name |
| `serviceName` | — | `openclaw` | OTEL service name |
| `enabled` | — | `true` | Enable/disable the plugin |
| `staleTraceTimeoutMs` | — | `300000` | Timeout for inactive traces (ms) |
| `staleTraceCleanupEnabled` | — | `true` | Auto-cleanup stale traces |

## OpenInference attributes

The plugin sets these standard attributes on spans:

- `openinference.span.kind` = `AGENT` | `LLM` | `TOOL`
- `input.value` / `output.value` — content as JSON or text
- `llm.model_name` / `llm.provider`
- `llm.input_messages.N.message.role` / `.content`
- `llm.output_messages.N.message.role` / `.content`
- `llm.token_count.prompt` / `.completion` / `.total`
- `tool.name` — for TOOL spans

## Security

A payload sanitizer strips internal metadata, untrusted context blocks, and media references before exporting. No raw user data or internal routing information is sent to Phoenix.

## License

Apache-2.0
