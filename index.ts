import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { initOtel, startRootSpan, startChildSpan, forceFlush, shutdown as shutdownOtel, getTracer } from "./src/service/otel-bridge.js";
import { sanitizeValue, sanitizeString } from "./src/service/payload-sanitizer.js";
import { normalizeProvider, resolveChannelId, resolveTrigger, safeStringify, formatError, asNonEmptyString, hasUsageFields, hasCostUsageFields } from "./src/service/helpers.js";
import { extractToolCallsFromMessages, setOpenInferenceMessageAttributes } from "./src/service/openinference-messages.js";
import { parsePhoenixPluginConfig, type ActiveTrace } from "./src/types.js";
import { DEFAULT_PROJECT_NAME, DEFAULT_SERVICE_NAME, DEFAULT_ENDPOINT, DEFAULT_STALE_TRACE_TIMEOUT_MS, DEFAULT_STALE_SWEEP_INTERVAL_MS, PHOENIX_PLUGIN_ID } from "./src/service/constants.js";

function extractMessageTextForScope(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;

  if (typeof m.content === "string") return m.content;
  if (typeof m.text === "string") return m.text;

  if (Array.isArray(m.content)) {
    const parts: string[] = [];
    for (const part of m.content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") parts.push(p.text);
      else if (typeof p.content === "string") parts.push(p.content);
      else if (typeof p.output === "string") parts.push(p.output);
    }
    return parts.join("\n\n").trim();
  }

  return "";
}

function scopeMessagesToCurrentTurn(messages: unknown, prompt?: string): unknown[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const promptText = typeof prompt === "string" ? prompt.trim() : "";
  if (!promptText) return messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = (message as Record<string, unknown>).role;
    if (role !== "user") continue;

    const text = extractMessageTextForScope(message).trim();
    if (!text) continue;

    if (text === promptText || text.includes(promptText) || promptText.includes(text)) {
      return messages.slice(i);
    }
  }

  return messages;
}

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
        const userPrompt = typeof event.prompt === "string" ? sanitizeString(event.prompt) : "";

        const rootSpan = startRootSpan(`${event.model} · ${channelId ?? "unknown"}`, {
          "openinference.span.kind": "AGENT",
          "input.value": userPrompt,
          "input.mime_type": "text/plain",
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

        // Set input messages on LLM span.  Deliberately avoid exporting raw
        // historyMessages here: OpenClaw history snapshots can include prior
        // turns' assistant tool calls/results, which makes Phoenix render stale
        // tools vertically inside the current LLM span.  Current-turn tool calls
        // are exported as first-class TOOL spans from agent_end instead.
        let idx = 0;
        if (event.systemPrompt && typeof event.systemPrompt === "string") {
          setOpenInferenceMessageAttributes(llmSpan, "llm.input_messages", idx, {
            role: "system",
            content: event.systemPrompt,
          });
          idx++;
        }
        if (event.prompt) {
          setOpenInferenceMessageAttributes(llmSpan, "llm.input_messages", idx, {
            role: "user",
            content: event.prompt,
          });
        }

        const now = Date.now();
        activeTraces.set(sessionKey, {
          rootSpan,
          llmSpan,
          toolSpans: new Map(),
          toolSpanKeysByName: new Map(),
          toolSpanSeq: 0,
          subagentSpans: new Map(), // Reserved for future subagent hook support
          startedAt: now,
          lastActivityAt: now,
          costMeta: {},
          usage: {},
          model: event.model,
          provider: normalizedProvider,
          channelId,
          trigger: resolveTrigger(agentCtx as Record<string, unknown>),
          prompt: userPrompt,
          agentId: asNonEmptyString(agentCtx.agentId),
          userId,
          completedToolCallIds: new Set(),
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

      if (sanitizedOutput.lastAssistant && typeof sanitizedOutput.lastAssistant === "object") {
        setOpenInferenceMessageAttributes(active.llmSpan, "llm.output_messages", 0, sanitizedOutput.lastAssistant);
      } else {
        for (let i = 0; i < texts.length; i++) {
          setOpenInferenceMessageAttributes(active.llmSpan, "llm.output_messages", i, {
            role: "assistant",
            content: texts[i],
          });
        }
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
          : `${event.toolName}:${++active.toolSpanSeq}`;

        if (toolCallId) {
          const id = String(toolCallId);
          toolSpan.setAttribute("tool.id", id);
          toolSpan.setAttribute("tool_call.id", id);
        }

        active.toolSpans.set(spanKey, toolSpan);
        const queue = active.toolSpanKeysByName.get(event.toolName) ?? [];
        queue.push(spanKey);
        active.toolSpanKeysByName.set(event.toolName, queue);
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
        const queue = active.toolSpanKeysByName.get(event.toolName);
        while (queue && queue.length > 0 && !matchedSpan) {
          const key = queue.shift();
          if (!key) continue;
          const span = active.toolSpans.get(key);
          if (!span) continue;
          matchedKey = key;
          matchedSpan = span;
        }
        if (queue && queue.length === 0) {
          active.toolSpanKeysByName.delete(event.toolName);
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
      if (toolCallId) {
        const queue = active.toolSpanKeysByName.get(event.toolName);
        if (queue && queue.length > 0) {
          const idx = queue.indexOf(matchedKey);
          if (idx >= 0) queue.splice(idx, 1);
          if (queue.length === 0) active.toolSpanKeysByName.delete(event.toolName);
        }
      }
      if (toolCallId) active.completedToolCallIds.add(String(toolCallId));
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
      active.toolSpanKeysByName.clear();
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

        // Some harnesses/providers preserve tool calls only in final message
        // snapshots instead of emitting before_tool_call/after_tool_call hooks.
        // Convert those message-level tool calls into first-class TOOL spans so
        // Phoenix renders them in the trace tree instead of burying them in one
        // scrollable chat transcript.
        const scopedMessages = scopeMessagesToCurrentTurn(event.messages, current.prompt);
        let postHocToolIndex = 0;
        for (const call of extractToolCallsFromMessages(scopedMessages)) {
          if (call.id && current.completedToolCallIds.has(call.id)) continue;
          try {
            const attrs: Record<string, string | number | boolean> = {
              "openinference.span.kind": "TOOL",
              "tool.name": call.name,
              "input.value": safeStringify(sanitizeValue(call.arguments ?? {})),
              "input.mime_type": "application/json",
              "tool_call.function.name": call.name,
            };
            if (call.id) {
              attrs["tool.id"] = call.id;
              attrs["tool_call.id"] = call.id;
            }
            if (call.arguments !== undefined) {
              attrs["tool_call.function.arguments"] = safeStringify(sanitizeValue(call.arguments));
            }
            const span = startChildSpan(current.rootSpan, call.name, {
              attributes: attrs,
              // These are reconstructed after agent_end, so there is no true
              // per-tool wall-clock timestamp.  Give Phoenix stable monotonic
              // start times so sorting preserves transcript order instead of
              // reversing same-millisecond spans nondeterministically.
              startTime: new Date(current.startedAt + 1_000 + postHocToolIndex++),
            });
            if (call.error) {
              span.setAttribute("output.value", safeStringify({ error: sanitizeString(call.error) }));
              span.setAttribute("output.mime_type", "application/json");
              span.setStatus({ code: SpanStatusCode.ERROR, message: sanitizeString(call.error) });
            } else if (call.result !== undefined) {
              span.setAttribute("output.value", safeStringify(sanitizeValue(call.result)));
              span.setAttribute("output.mime_type", "application/json");
              span.setStatus({ code: SpanStatusCode.OK });
            } else {
              span.setStatus({ code: SpanStatusCode.OK });
            }
            span.end();
            if (call.id) current.completedToolCallIds.add(call.id);
          } catch (err) {
            console.warn(`[phoenix-otel] post-hoc tool span creation failed: ${formatError(err)}`);
          }
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
      async start(ctx: any) {
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
