# OpenClaw Phoenix OTEL Plugin

Export full agent traces from [OpenClaw](https://github.com/openclaw/openclaw) to [Phoenix (Arize)](https://phoenix.arize.com) via OpenTelemetry.

![Trace list in Phoenix](screenshot-traces.jpg)

![Trace detail with span hierarchy](screenshot-detail.jpg)

## What it captures

- **LLM prompts and responses** (full input/output content)
- **Tool calls** with inputs, outputs, and errors
- **Sub-agent lifecycle** spans
- **Token usage** (prompt, completion, cache read/write)
- **Cost metadata** from diagnostic events
- **Proper span hierarchy**: AGENT → LLM → TOOL
- **OpenInference semantic conventions** for native Phoenix rendering

## Quick Start

> **Already have OpenClaw?** Ask your assistant:
> *"Please read https://raw.githubusercontent.com/exiao/openclaw-phoenix-otel/main/SETUP.md and follow the instructions to install the Phoenix OTEL plugin."*

### Manual install

```bash
git clone https://github.com/exiao/openclaw-phoenix-otel.git
cd openclaw-phoenix-otel
npm install
openclaw plugins install .
```

Then add your Phoenix credentials to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["phoenix-otel"],
    "entries": {
      "phoenix-otel": {
        "enabled": true,
        "config": {
          "endpoint": "https://app.phoenix.arize.com/s/your-space",
          "apiKey": "your-phoenix-api-key",
          "projectName": "openclaw",
          "serviceName": "openclaw"
        }
      }
    }
  }
}
```

Restart the gateway:

```bash
openclaw gateway restart
```

For detailed setup instructions, troubleshooting, and verification steps, see **[SETUP.md](SETUP.md)**.

## Config options

| Option | Default | Description |
|--------|---------|-------------|
| `endpoint` | `https://app.phoenix.arize.com` | Phoenix collector endpoint |
| `apiKey` | — | Phoenix API key (Settings → API Keys) |
| `projectName` | `openclaw` | Phoenix project name |
| `serviceName` | `openclaw` | OTEL service name |

Environment variables `PHOENIX_HOST`, `PHOENIX_API_KEY`, and `PHOENIX_PROJECT_NAME` are also supported.

## How it works

The plugin hooks into OpenClaw's plugin SDK events:

- `llm_input` → creates root AGENT span + child LLM span with prompt content
- `llm_output` → sets response content, token counts on LLM span
- `before_tool_call` / `after_tool_call` → creates TOOL spans with I/O
- `agent_end` → finalizes the trace with metadata and cost
- Diagnostic `model.usage` events → accumulates cost/token metadata

Spans use [OpenInference semantic conventions](https://github.com/Arize-ai/openinference) so Phoenix renders them natively with proper LLM trace visualization.

## Notes

- Disable the built-in `diagnostics-otel` plugin to avoid conflicts (two OTEL providers in the same process can interfere)
- OTEL exports use `Authorization: Bearer <key>` for the OTLP endpoint (not `api_key` header)
- The plugin initializes OTEL during `register()` to ensure hooks can create spans immediately

## License

Apache-2.0
