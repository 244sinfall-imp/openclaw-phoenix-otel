# Phoenix OTEL Plugin — Setup Guide

This guide walks you through installing the openclaw-phoenix-otel plugin, which exports your OpenClaw agent traces to Phoenix (Arize) via OpenTelemetry.

## Prerequisites

- OpenClaw installed and running
- A Phoenix account (free at [phoenix.arize.com](https://phoenix.arize.com)) or a self-hosted Phoenix instance
- Node.js and npm

## Step 1: Get your Phoenix credentials

1. Go to [app.phoenix.arize.com](https://app.phoenix.arize.com) and sign in
2. Note your space URL (e.g., `https://app.phoenix.arize.com/s/your-space`)
3. Go to **Settings → API Keys → Create API Key** and copy it

For self-hosted Phoenix, your endpoint is wherever Phoenix runs (e.g., `http://localhost:6006`).

## Step 2: Install the plugin

Clone the repo and install it:

```bash
git clone https://github.com/exiao/openclaw-phoenix-otel.git
cd openclaw-phoenix-otel
npm install
openclaw plugins install .
```

The `openclaw plugins install .` command copies the plugin into OpenClaw's extensions directory and registers it.

## Step 3: Configure

After install, OpenClaw will have added the plugin to your config. You need to add your Phoenix credentials.

Open `~/.openclaw/openclaw.json` and find the `plugins` section. Update the `phoenix-otel` entry:

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

Replace `endpoint` and `apiKey` with your actual values from Step 1.

Alternatively, you can set environment variables instead of editing the config:

```bash
export PHOENIX_HOST="https://app.phoenix.arize.com/s/your-space"
export PHOENIX_API_KEY="your-phoenix-api-key"
```

### Config options

| Option | Default | Description |
|--------|---------|-------------|
| `endpoint` | `https://app.phoenix.arize.com` | Phoenix collector endpoint |
| `apiKey` | — | Phoenix API key |
| `projectName` | `openclaw` | Project name in Phoenix (traces appear here) |
| `serviceName` | `openclaw` | OTEL service name |

## Step 4: Disable diagnostics-otel (if active)

If you have the built-in `diagnostics-otel` plugin enabled, disable it to avoid conflicts — two OTEL providers in the same process can interfere:

```json
{
  "plugins": {
    "entries": {
      "diagnostics-otel": {
        "enabled": false
      }
    }
  }
}
```

## Step 5: Restart OpenClaw

```bash
openclaw gateway restart
```

## Step 6: Verify

Send a message to your OpenClaw assistant, then check Phoenix. You should see traces under your configured project name with:

- **AGENT** root span — one per conversation turn, shows user prompt and assistant response
- **LLM** child span — model name, full input/output messages, token counts
- **TOOL** child spans — one per tool call with inputs and outputs

Example trace hierarchy:

```
AGENT: "claude-opus-4 · signal"
├── LLM: "claude-opus-4"
├── TOOL: "web_fetch"
├── TOOL: "exec"
└── TOOL: "memory_search"
```

## Troubleshooting

**No traces appearing:**
- Run `openclaw plugins list` and confirm `phoenix-otel` shows as enabled
- Run `openclaw plugins doctor` to check for load errors
- Verify your `endpoint` and `apiKey` are correct
- Check gateway logs for `[phoenix-otel]` messages

**Plugin ID mismatch warning:**
- Make sure the config entry key matches the plugin ID: use `"phoenix-otel"` (not `"openclaw-phoenix-otel"`)

**Traces have no output:**
- The `agent_end` event must fire for output to be captured
- Timed-out or crashed conversations may not finalize properly

## Updating

To update to the latest version:

```bash
cd openclaw-phoenix-otel
git pull
npm install
openclaw plugins install .
openclaw gateway restart
```
