import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ActiveTrace } from "../../types.js";
import { normalizeProvider, resolveChannelId, resolveTrigger, safeStringify } from "../helpers.js";
import { startChildSpan, startRootSpan } from "../otel-bridge.js";
import { sanitizeValue } from "../payload-sanitizer.js";

type LlmHooksDeps = {
  api: OpenClawPluginApi;
  activeTraces: Map<string, ActiveTrace>;
  isReady: () => boolean;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  closeActiveTrace: (active: ActiveTrace, reason: string) => void;
  forgetSessionCorrelation: (sessionKey: string) => void;
  applyContextMeta: (active: ActiveTrace, ctx: Record<string, unknown>) => void;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

function setInputMessages(span: Span, prompt: unknown, systemPrompt: unknown, historyMessages: unknown): void {
  let idx = 0;
  if (systemPrompt && typeof systemPrompt === "string") {
    span.setAttribute(`llm.input_messages.${idx}.message.role`, "system");
    span.setAttribute(`llm.input_messages.${idx}.message.content`, safeStringify(systemPrompt));
    idx++;
  }
  if (Array.isArray(historyMessages)) {
    for (const msg of historyMessages) {
      if (msg && typeof msg === "object" && "role" in msg) {
        const m = msg as Record<string, unknown>;
        span.setAttribute(`llm.input_messages.${idx}.message.role`, String(m.role ?? "user"));
        span.setAttribute(`llm.input_messages.${idx}.message.content`, safeStringify(m.content ?? m.text ?? ""));
        idx++;
      }
    }
  }
  if (prompt) {
    span.setAttribute(`llm.input_messages.${idx}.message.role`, "user");
    span.setAttribute(`llm.input_messages.${idx}.message.content`, safeStringify(prompt));
  }
}

export function registerLlmHooks(deps: LlmHooksDeps): void {
  deps.api.on("llm_input", (event: any, agentCtx: any) => {
    if (!deps.isReady()) return;
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, agentCtx.agentId);
    const normalizedProvider = normalizeProvider(event.provider) ?? event.provider;
    const agentCtxObj = agentCtx as Record<string, unknown>;
    const channelId = resolveChannelId(agentCtxObj);
    const trigger = resolveTrigger(agentCtxObj);

    const existing = deps.activeTraces.get(sessionKey);
    if (existing) {
      deps.closeActiveTrace(existing, `replace active trace sessionKey=${sessionKey}`);
      deps.activeTraces.delete(sessionKey);
      deps.forgetSessionCorrelation(sessionKey);
    }

    // Create root AGENT span
    let rootSpan: Span;
    try {
      const sanitizedInput = sanitizeValue({
        prompt: event.prompt,
        systemPrompt: event.systemPrompt,
        imagesCount: event.imagesCount,
      }) as Record<string, unknown>;

      rootSpan = startRootSpan(`${event.model} · ${channelId ?? "unknown"}`, {
        "openinference.span.kind": "AGENT",
        "input.value": safeStringify(sanitizedInput),
        "input.mime_type": "application/json",
        "llm.model_name": event.model ?? "",
        "llm.provider": normalizedProvider ?? "",
        "session.id": sessionKey,
      });
    } catch (err) {
      deps.warn(`phoenix: root span creation failed (sessionKey=${sessionKey}): ${deps.formatError(err)}`);
      return;
    }

    // Create child LLM span
    let llmSpan: Span | null = null;
    try {
      const sanitizedLlmInput = sanitizeValue({
        prompt: event.prompt,
        systemPrompt: event.systemPrompt,
        historyMessages: event.historyMessages,
        imagesCount: event.imagesCount,
      }) as Record<string, unknown>;

      llmSpan = startChildSpan(rootSpan, event.model ?? "llm", {
        attributes: {
          "openinference.span.kind": "LLM",
          "input.value": safeStringify(sanitizedLlmInput),
          "input.mime_type": "application/json",
          "llm.model_name": event.model ?? "",
          "llm.provider": normalizedProvider ?? "",
        },
      });

      setInputMessages(llmSpan, event.prompt, event.systemPrompt, event.historyMessages);
    } catch (err) {
      deps.warn(`phoenix: llm span creation failed (sessionKey=${sessionKey}): ${deps.formatError(err)}`);
    }

    const now = Date.now();
    deps.activeTraces.set(sessionKey, {
      rootSpan,
      llmSpan,
      toolSpans: new Map(),
      subagentSpans: new Map(),
      startedAt: now,
      lastActivityAt: now,
      costMeta: {},
      usage: {},
      model: event.model,
      provider: normalizedProvider,
      channelId,
      trigger,
    });
  });

  deps.api.on("llm_output", (event: any, agentCtx: any) => {
    if (!deps.isReady()) return;
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, agentCtx.agentId);
    const normalizedProvider = normalizeProvider(event.provider) ?? event.provider;

    const active = deps.activeTraces.get(sessionKey);
    if (!active?.llmSpan) return;

    deps.applyContextMeta(active, agentCtx as Record<string, unknown>);
    active.lastActivityAt = Date.now();

    const sanitizedOutput = sanitizeValue({
      assistantTexts: event.assistantTexts,
      lastAssistant: event.lastAssistant,
    }) as { assistantTexts?: unknown; lastAssistant?: unknown };

    const sanitizedAssistantTexts = Array.isArray(sanitizedOutput.assistantTexts)
      ? sanitizedOutput.assistantTexts.filter((item): item is string => typeof item === "string")
      : [];

    const outputText = sanitizedAssistantTexts.join("\n\n");

    // Set LLM span output attributes
    active.llmSpan.setAttribute("output.value", safeStringify(outputText));
    active.llmSpan.setAttribute("output.mime_type", "text/plain");
    active.llmSpan.setAttribute("llm.model_name", event.model ?? active.model ?? "");
    active.llmSpan.setAttribute("llm.provider", normalizedProvider ?? active.provider ?? "");

    // Set output messages
    if (sanitizedAssistantTexts.length > 0) {
      for (let i = 0; i < sanitizedAssistantTexts.length; i++) {
        active.llmSpan.setAttribute(`llm.output_messages.${i}.message.role`, "assistant");
        active.llmSpan.setAttribute(`llm.output_messages.${i}.message.content`, sanitizedAssistantTexts[i]);
      }
    }

    // Set token counts
    if (event.usage) {
      if (event.usage.input != null) active.llmSpan.setAttribute("llm.token_count.prompt", event.usage.input as number);
      if (event.usage.output != null) active.llmSpan.setAttribute("llm.token_count.completion", event.usage.output as number);
      if (event.usage.total != null) active.llmSpan.setAttribute("llm.token_count.total", event.usage.total as number);
      if (event.usage.cacheRead != null) active.llmSpan.setAttribute("llm.token_count.prompt_details.cache_read", event.usage.cacheRead as number);
      if (event.usage.cacheWrite != null) active.llmSpan.setAttribute("llm.token_count.prompt_details.cache_write", event.usage.cacheWrite as number);
    }

    active.llmSpan.setStatus({ code: SpanStatusCode.OK });
    active.llmSpan.end();
    active.llmSpan = null;

    // Store output for trace finalization
    active.output = { output: outputText, lastAssistant: sanitizedOutput.lastAssistant };
    if (event.usage) {
      active.usage = { ...active.usage, ...event.usage };
    }
    active.model = event.model;
    active.provider = normalizedProvider;
  });
}
