import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { initOtel, startRootSpan, startChildSpan, forceFlush, shutdown as shutdownOtel, getTracer } from "./src/service/otel-bridge.js";
import { sanitizeValue, sanitizeString } from "./src/service/payload-sanitizer.js";
import { normalizeProvider, resolveChannelId, resolveTrigger, safeStringify, formatError, asNonEmptyString, hasUsageFields, hasCostUsageFields } from "./src/service/helpers.js";
import { parsePhoenixPluginConfig, type ActiveTrace } from "./src/types.js";
import { DEFAULT_PROJECT_NAME, DEFAULT_SERVICE_NAME, DEFAULT_ENDPOINT, DEFAULT_STALE_TRACE_TIMEOUT_MS, DEFAULT_STALE_SWEEP_INTERVAL_MS, PHOENIX_PLUGIN_ID } from "./src/service/constants.js";

const plugin = {
  id: "phoenix-otel",
  name: "Phoenix OTEL",
  description: "Export LLM traces and spans to Phoenix (Arize) via OpenTelemetry",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const pluginConfig = parsePhoenixPluginConfig(api.pluginConfig);
    const activeTraces = new Map<string, ActiveTrace>();
    let lastActiveSessionKey: string | undefined;
    const sessionByAgentId = new Map<string, string>();
    let staleSweepTimer: ReturnType<typeof setInterval> | null = null;

    // Init OTEL immediately in register() so hooks can create spans right away
    const endpoint = pluginConfig.endpoint ?? process.env.PHOENIX_HOST ?? DEFAULT_ENDPOINT;
    const apiKey = pluginConfig.apiKey ?? process.env.PHOENIX_API_KEY;
    const projectName = pluginConfig.projectName ?? process.env.PHOENIX_PROJECT_NAME ?? DEFAULT_PROJECT_NAME;
    const serviceName = pluginConfig.serviceName ?? DEFAULT_SERVICE_NAME;
    initOtel({ endpoint, apiKey, projectName, serviceName });

    function isReady(): boolean {
      return getTracer() !== null;
    }

    function rememberSession(sessionKey: string, agentId?: unknown): void {
      lastActiveSessionKey = sessionKey;
      if (typeof agentId === "string" && agentId.length > 0) {
        sessionByAgentId.set(agentId, sessionKey);
      }
    }

    // ---- LLM INPUT ----
    api.on("llm_input", (event: any, agentCtx: any) => {
      if (!isReady()) return;
      const sessionKey = agentCtx.sessionKey;
      if (!sessionKey) return;
      rememberSession(sessionKey, agentCtx.agentId);

      const normalizedProvider = normalizeProvider(event.provider) ?? event.provider;
      const channelId = resolveChannelId(agentCtx as Record<string, unknown>);

      // Close existing trace for this session
      const existing = activeTraces.get(sessionKey);
      if (existing) {
        try { existing.rootSpan.end(); } catch {}
        activeTraces.delete(sessionKey);
      }

      try {
        const sanitizedInput = sanitizeValue({
          prompt: event.prompt,
          systemPrompt: event.systemPrompt,
          imagesCount: event.imagesCount,
        }) as Record<string, unknown>;

        const rootSpan = startRootSpan(`${event.model} · ${channelId ?? "unknown"}`, {
          "openinference.span.kind": "AGENT",
          "input.value": safeStringify(sanitizedInput),
          "input.mime_type": "application/json",
          "llm.model_name": event.model ?? "",
          "llm.provider": normalizedProvider ?? "",
          "session.id": sessionKey,
          // [6] agent.name on root AGENT span
          "agent.name": serviceName,
        });

        // [3] Add user.id from agentCtx sender info
        const userId = asNonEmptyString(agentCtx.senderId)
          ?? asNonEmptyString(agentCtx.userId)
          ?? asNonEmptyString(agentCtx.senderName);
        if (userId) {
          rootSpan.setAttribute("user.id", userId);
        }

        // Create child LLM span
        const sanitizedLlmInput = sanitizeValue({
          prompt: event.prompt,
          systemPrompt: event.systemPrompt,
          historyMessages: event.historyMessages,
          imagesCount: event.imagesCount,
        }) as Record<string, unknown>;

        const llmSpan = startChildSpan(rootSpan, event.model ?? "llm", {
          attributes: {
            "openinference.span.kind": "LLM",
            "input.value": safeStringify(sanitizedLlmInput),
            "input.mime_type": "application/json",
            "llm.model_name": event.model ?? "",
            "llm.provider": normalizedProvider ?? "",
          },
        });

        // [10] Add llm.invocation_parameters if available
        const invocationParams = event.invocationParams ?? event.params;
        if (invocationParams && typeof invocationParams === "object" && Object.keys(invocationParams).length > 0) {
          llmSpan.setAttribute("llm.invocation_parameters", safeStringify(invocationParams));
        }

        // Set input messages on LLM span
        let idx = 0;
        if (event.systemPrompt && typeof event.systemPrompt === "string") {
          llmSpan.setAttribute(`llm.input_messages.${idx}.message.role`, "system");
          llmSpan.setAttribute(`llm.input_messages.${idx}.message.content`, safeStringify(event.systemPrompt));
          idx++;
        }
        if (Array.isArray(event.historyMessages)) {
          for (const msg of event.historyMessages) {
            if (msg && typeof msg === "object" && "role" in msg) {
              llmSpan.setAttribute(`llm.input_messages.${idx}.message.role`, String(msg.role ?? "user"));
              llmSpan.setAttribute(`llm.input_messages.${idx}.message.content`, safeStringify(msg.content ?? msg.text ?? ""));
              idx++;
            }
          }
        }
        if (event.prompt) {
          llmSpan.setAttribute(`llm.input_messages.${idx}.message.role`, "user");
          llmSpan.setAttribute(`llm.input_messages.${idx}.message.content`, safeStringify(event.prompt));
        }

        const now = Date.now();
        activeTraces.set(sessionKey, {
          rootSpan,
          llmSpan,
          toolSpans: new Map(),
          subagentSpans: new Map(), // Reserved for future subagent hook support
          startedAt: now,
          lastActivityAt: now,
          costMeta: {},
          usage: {},
          model: event.model,
          provider: normalizedProvider,
          channelId,
          trigger: resolveTrigger(agentCtx as Record<string, unknown>),
          agentId: asNonEmptyString(agentCtx.agentId),
          userId,
        });
      } catch (err) {
        console.warn(`[phoenix-otel] llm_input span creation failed: ${formatError(err)}`);
      }
    });

    // ---- LLM OUTPUT ----
    api.on("llm_output", (event: any, agentCtx: any) => {
      if (!isReady()) return;
      const sessionKey = agentCtx.sessionKey;
      if (!sessionKey) return;

      const active = activeTraces.get(sessionKey);
      if (!active?.llmSpan) return;

      active.lastActivityAt = Date.now();
      const normalizedProvider = normalizeProvider(event.provider) ?? event.provider;

      const sanitizedOutput = sanitizeValue({
        assistantTexts: event.assistantTexts,
        lastAssistant: event.lastAssistant,
      }) as { assistantTexts?: unknown; lastAssistant?: unknown };

      const texts = Array.isArray(sanitizedOutput.assistantTexts)
        ? sanitizedOutput.assistantTexts.filter((item: unknown): item is string => typeof item === "string")
        : [];
      const outputText = texts.join("\n\n");

      active.llmSpan.setAttribute("output.value", outputText);
      active.llmSpan.setAttribute("output.mime_type", "text/plain");
      active.llmSpan.setAttribute("llm.model_name", event.model ?? active.model ?? "");
      active.llmSpan.setAttribute("llm.provider", normalizedProvider ?? active.provider ?? "");

      for (let i = 0; i < texts.length; i++) {
        active.llmSpan.setAttribute(`llm.output_messages.${i}.message.role`, "assistant");
        active.llmSpan.setAttribute(`llm.output_messages.${i}.message.content`, texts[i]);
      }

      if (event.usage) {
        if (event.usage.input != null) active.llmSpan.setAttribute("llm.token_count.prompt", event.usage.input);
        if (event.usage.output != null) active.llmSpan.setAttribute("llm.token_count.completion", event.usage.output);
        if (event.usage.total != null) active.llmSpan.setAttribute("llm.token_count.total", event.usage.total);
        if (event.usage.cacheRead != null) active.llmSpan.setAttribute("llm.token_count.prompt_details.cache_read", event.usage.cacheRead);
        if (event.usage.cacheWrite != null) active.llmSpan.setAttribute("llm.token_count.prompt_details.cache_write", event.usage.cacheWrite);
        // [9] Add reasoning token count
        if (event.usage.reasoning != null) active.llmSpan.setAttribute("llm.token_count.completion_details.reasoning", event.usage.reasoning);
      }

      active.llmSpan.setStatus({ code: SpanStatusCode.OK });
      active.llmSpan.end();
      active.llmSpan = null;

      active.output = { output: outputText, lastAssistant: sanitizedOutput.lastAssistant };
      if (event.usage) active.usage = { ...active.usage, ...event.usage };
      active.model = event.model;
      active.provider = normalizedProvider;
    });

    // ---- TOOL CALLS ----
    // [1] openinference.span.kind: "TOOL" is set as top-level attribute
    api.on("before_tool_call", (event: any, toolCtx: any) => {
      if (!isReady()) return;
      const sessionKey = toolCtx.sessionKey;
      if (!sessionKey) return;

      const active = activeTraces.get(sessionKey);
      if (!active) return;
      active.lastActivityAt = Date.now();

      try {
        const toolSpan = startChildSpan(active.rootSpan, event.toolName, {
          attributes: {
            "openinference.span.kind": "TOOL",
            "tool.name": event.toolName,
            "input.value": safeStringify(sanitizeValue(event.params)),
            "input.mime_type": "application/json",
          },
        });

        const toolCallId = event.toolCallId ?? toolCtx.toolCallId;
        const spanKey = toolCallId
          ? `toolcall:${toolCallId}`
          : `${event.toolName}:${Date.now()}`;
        active.toolSpans.set(spanKey, toolSpan);
      } catch (err) {
        console.warn(`[phoenix-otel] tool span creation failed: ${formatError(err)}`);
      }
    });

    api.on("after_tool_call", (event: any, toolCtx: any) => {
      if (!isReady()) return;
      const sessionKey = toolCtx.sessionKey ?? lastActiveSessionKey;
      if (!sessionKey) return;

      const active = activeTraces.get(sessionKey);
      if (!active) return;
      active.lastActivityAt = Date.now();

      const toolCallId = event.toolCallId ?? toolCtx.toolCallId;
      let matchedKey: string | undefined;
      let matchedSpan: Span | undefined;

      if (toolCallId) {
        const key = `toolcall:${toolCallId}`;
        matchedSpan = active.toolSpans.get(key);
        if (matchedSpan) matchedKey = key;
      }
      if (!matchedSpan) {
        for (const [key, span] of active.toolSpans) {
          if (key.startsWith(`${event.toolName}:`)) {
            matchedKey = key;
            matchedSpan = span;
            break;
          }
        }
      }
      if (!matchedKey || !matchedSpan) return;

      if (event.error) {
        matchedSpan.setAttribute("output.value", safeStringify({ error: sanitizeString(event.error) }));
        matchedSpan.setAttribute("output.mime_type", "application/json");
        matchedSpan.setStatus({ code: SpanStatusCode.ERROR, message: sanitizeString(event.error) });
      } else if (event.result !== undefined) {
        matchedSpan.setAttribute("output.value", safeStringify(sanitizeValue(event.result)));
        matchedSpan.setAttribute("output.mime_type", "application/json");
        matchedSpan.setStatus({ code: SpanStatusCode.OK });
      }

      matchedSpan.end();
      active.toolSpans.delete(matchedKey);
    });

    // ---- AGENT END ----
    api.on("agent_end", (event: any, agentCtx: any) => {
      if (!isReady()) return;
      const sessionKey = agentCtx.sessionKey;
      if (!sessionKey) return;

      const active = activeTraces.get(sessionKey);
      if (!active) return;

      // End orphaned spans
      for (const [, s] of active.toolSpans) { try { s.end(); } catch {} }
      active.toolSpans.clear();
      for (const [, s] of active.subagentSpans) { try { s.end(); } catch {} }
      active.subagentSpans.clear();
      if (active.llmSpan) { try { active.llmSpan.end(); } catch {} active.llmSpan = null; }

      // Defer finalization so llm_output fires first
      const rootRef = active.rootSpan;
      queueMicrotask(() => {
        const current = activeTraces.get(sessionKey);
        if (!current || current.rootSpan !== rootRef) return;

        // [5] Fix output.value: extract plain text instead of raw JSON
        let outputText = "";
        if (current.output) {
          outputText = current.output.output;
        } else if (event.messages?.length) {
          const last = [...event.messages].reverse().find((m: any) => m?.role === "assistant");
          if (last) {
            // Extract text content from message object
            if (typeof last.content === "string") {
              outputText = last.content;
            } else if (Array.isArray(last.content)) {
              outputText = last.content
                .filter((c: any) => c && (c.type === "text" || typeof c === "string"))
                .map((c: any) => typeof c === "string" ? c : c.text ?? "")
                .join("\n\n");
            } else {
              outputText = safeStringify(last);
            }
          }
        }

        if (outputText) {
          current.rootSpan.setAttribute("output.value", outputText);
          current.rootSpan.setAttribute("output.mime_type", "text/plain");
        }

        const model = current.model ?? current.costMeta.model;
        const provider = current.provider ?? current.costMeta.provider;
        if (model) current.rootSpan.setAttribute("llm.model_name", model);
        if (provider) current.rootSpan.setAttribute("llm.provider", provider);

        // [4] Add metadata JSON attribute (includes channel, so no standalone metadata.channel needed)
        const metadata: Record<string, string> = {};
        if (current.channelId) metadata.channel = current.channelId;
        if (current.trigger) metadata.trigger = current.trigger;
        if (current.agentId) metadata.agentId = current.agentId;
        if (sessionKey) metadata.sessionKey = sessionKey;
        if (Object.keys(metadata).length > 0) {
          current.rootSpan.setAttribute("metadata", JSON.stringify(metadata));
        }

        const usage = hasUsageFields(current.usage) ? current.usage : (hasCostUsageFields(current.costMeta) ? {
          input: current.costMeta.usageInput, output: current.costMeta.usageOutput, total: current.costMeta.usageTotal,
        } : null);
        if (usage) {
          if (usage.input != null) current.rootSpan.setAttribute("llm.token_count.prompt", usage.input);
          if (usage.output != null) current.rootSpan.setAttribute("llm.token_count.completion", usage.output);
          if (usage.total != null) current.rootSpan.setAttribute("llm.token_count.total", usage.total);
        }

        if (event.error) {
          current.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) });
        } else {
          current.rootSpan.setStatus({ code: SpanStatusCode.OK });
        }

        current.rootSpan.end();
        activeTraces.delete(sessionKey);
      });
    });

    // ---- SERVICE (just handles OTEL init/shutdown) ----
    api.registerService({
      id: PHOENIX_PLUGIN_ID,
      async start(ctx) {
        ctx.logger.info(`phoenix: tracing to "${projectName}" at ${endpoint}`);
        // Subscribe to diagnostic events for cost metadata
        onDiagnosticEvent((evt: any) => {
          if (evt.type !== "model.usage") return;
          const active = activeTraces.get(evt.sessionKey);
          if (!active) return;
          if (evt.costUsd !== undefined) active.costMeta.costUsd = evt.costUsd;
          if (evt.model) active.costMeta.model = evt.model;
          if (evt.provider) active.costMeta.provider = normalizeProvider(evt.provider) ?? evt.provider;
          if (evt.usage) {
            active.costMeta.usageInput = evt.usage.input;
            active.costMeta.usageOutput = evt.usage.output;
            active.costMeta.usageTotal = evt.usage.total;
          }
        });

        // [8] Stale trace cleanup
        const staleTimeout = pluginConfig.staleTraceTimeoutMs ?? DEFAULT_STALE_TRACE_TIMEOUT_MS;
        const sweepInterval = pluginConfig.staleSweepIntervalMs ?? DEFAULT_STALE_SWEEP_INTERVAL_MS;
        const cleanupEnabled = pluginConfig.staleTraceCleanupEnabled !== false; // enabled by default

        if (cleanupEnabled) {
          staleSweepTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, trace] of activeTraces) {
              if (now - trace.lastActivityAt > staleTimeout) {
                ctx.logger.warn(`phoenix: cleaning up stale trace for session ${key} (inactive for ${Math.round((now - trace.lastActivityAt) / 1000)}s)`);
                // End orphaned spans
                for (const [, s] of trace.toolSpans) { try { s.end(); } catch {} }
                for (const [, s] of trace.subagentSpans) { try { s.end(); } catch {} }
                if (trace.llmSpan) { try { trace.llmSpan.end(); } catch {} }
                trace.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: "Stale trace cleaned up" });
                try { trace.rootSpan.end(); } catch {}
                activeTraces.delete(key);
              }
            }
          }, sweepInterval);
        }

        ctx.logger.info(`phoenix: exporting traces to "${projectName}" at ${endpoint}`);
      },
      async stop() {
        // [8] Clear stale sweep interval
        if (staleSweepTimer) {
          clearInterval(staleSweepTimer);
          staleSweepTimer = null;
        }

        for (const [, active] of activeTraces) {
          try { active.rootSpan.end(); } catch {}
        }
        activeTraces.clear();
        await forceFlush();
        await shutdownOtel();
      },
    });
  },
};

export default plugin;
