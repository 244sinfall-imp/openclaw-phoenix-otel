import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type {
  DiagnosticEventPayload,
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import {
  DEFAULT_STALE_SWEEP_INTERVAL_MS,
  DEFAULT_STALE_TRACE_TIMEOUT_MS,
  PHOENIX_PLUGIN_ID,
  DEFAULT_PROJECT_NAME,
  DEFAULT_SERVICE_NAME,
  DEFAULT_ENDPOINT,
} from "./service/constants.js";
import {
  asNonEmptyString,
  asNonNegativeNumber,
  formatError,
  hasCostUsageFields,
  hasUsageFields,
  normalizeProvider,
  resolveChannelId,
  resolveTrigger,
  safeStringify,
} from "./service/helpers.js";
import { registerLlmHooks } from "./service/hooks/llm.js";
import { registerSubagentHooks } from "./service/hooks/subagent.js";
import { registerToolHooks } from "./service/hooks/tool.js";
import { initOtel, forceFlush, shutdown as shutdownOtel, startChildSpan, getTracer } from "./service/otel-bridge.js";
import { sanitizeString, sanitizeValue } from "./service/payload-sanitizer.js";
import { parsePhoenixPluginConfig, type ActiveTrace, type PhoenixPluginConfig } from "./types.js";

type ServiceLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export function createPhoenixService(
  api: OpenClawPluginApi,
  pluginConfig: PhoenixPluginConfig = {},
): OpenClawPluginService {
  const activeTraces = new Map<string, ActiveTrace>();
  const subagentSpanHosts = new Map<
    string,
    { hostSessionKey: string; active: ActiveTrace; span: Span }
  >();
  const sessionByAgentId = new Map<string, string>();
  let cleanup: (() => void) | null = null;
  let spanSeq = 0;
  let lastActiveSessionKey: string | undefined;
  let warnedMissingAfterToolSessionKey = false;
  let otelReady = false;
  let log: ServiceLogger = {
    info: (msg) => console.log(`[phoenix-otel] ${msg}`),
    warn: (msg) => console.warn(`[phoenix-otel] ${msg}`),
  };

  let staleTraceTimeoutMs = DEFAULT_STALE_TRACE_TIMEOUT_MS;
  let staleSweepIntervalMs = DEFAULT_STALE_SWEEP_INTERVAL_MS;
  let staleTraceCleanupEnabled = true;

  function isReady(): boolean {
    return otelReady && getTracer() !== null;
  }

  function rememberSessionCorrelation(sessionKey: string, agentId?: unknown): void {
    lastActiveSessionKey = sessionKey;
    if (typeof agentId === "string" && agentId.length > 0) {
      sessionByAgentId.set(agentId, sessionKey);
    }
  }

  function applyContextMeta(active: ActiveTrace, ctx: Record<string, unknown>): void {
    const explicitChannelId = asNonEmptyString(ctx.channelId);
    const fallbackChannel = asNonEmptyString(ctx.messageProvider);
    if (explicitChannelId) {
      active.channelId = explicitChannelId;
    } else if (!active.channelId && fallbackChannel) {
      active.channelId = fallbackChannel;
    }
    const trigger = resolveTrigger(ctx);
    if (trigger) active.trigger = trigger;
  }

  function forgetSessionCorrelation(sessionKey: string): void {
    if (lastActiveSessionKey === sessionKey) lastActiveSessionKey = undefined;
    for (const [agentId, mappedSessionKey] of sessionByAgentId) {
      if (mappedSessionKey === sessionKey) sessionByAgentId.delete(agentId);
    }
  }

  function rememberSubagentSpanHost(
    sessionKey: string, hostSessionKey: string, active: ActiveTrace, span: Span,
  ): void {
    subagentSpanHosts.set(sessionKey, { hostSessionKey, active, span });
  }

  function getSubagentSpanHost(sessionKey: string) {
    return subagentSpanHosts.get(sessionKey);
  }

  function forgetSubagentSpanHost(sessionKey: string): void {
    subagentSpanHosts.delete(sessionKey);
  }

  function forgetSubagentSpanHostsByActive(active: ActiveTrace): void {
    for (const [sessionKey, spanHost] of subagentSpanHosts) {
      if (spanHost.active === active) subagentSpanHosts.delete(sessionKey);
    }
  }

  function warnMissingAfterToolSessionKey(fallbackMode: string): void {
    if (warnedMissingAfterToolSessionKey) return;
    warnedMissingAfterToolSessionKey = true;
    log.warn(`after_tool_call missing sessionKey; using ${fallbackMode} fallback`);
  }

  function endChildSpans(active: ActiveTrace, _reason: string): void {
    for (const [, toolSpan] of active.toolSpans) {
      try { toolSpan.end(); } catch {}
    }
    active.toolSpans.clear();
    for (const [, subagentSpan] of active.subagentSpans) {
      try { subagentSpan.end(); } catch {}
    }
    active.subagentSpans.clear();
    if (active.llmSpan) {
      try { active.llmSpan.end(); } catch {}
      active.llmSpan = null;
    }
  }

  function closeActiveTrace(active: ActiveTrace, reason: string): void {
    endChildSpans(active, reason);
    forgetSubagentSpanHostsByActive(active);
    active.agentEnd = undefined;
    active.output = undefined;
    try { active.rootSpan.end(); } catch {}
  }

  function resolveSessionSpanContainer(sessionKey: string) {
    const spanHost = getSubagentSpanHost(sessionKey);
    if (spanHost) {
      return { sessionKey: spanHost.hostSessionKey, active: spanHost.active, parentSpan: spanHost.span };
    }
    const active = activeTraces.get(sessionKey);
    if (active) {
      return { sessionKey, active, parentSpan: active.rootSpan };
    }
    return undefined;
  }

  function resolveSubagentSpanContainer(params: {
    requesterSessionKey?: string; childSessionKey?: string; targetSessionKey?: string;
  }) {
    if (params.requesterSessionKey) {
      const c = resolveSessionSpanContainer(params.requesterSessionKey);
      if (c) return c;
    }
    for (const key of [params.childSessionKey, params.targetSessionKey]) {
      if (!key) continue;
      const active = activeTraces.get(key);
      if (active) return { sessionKey: key, active, parentSpan: active.rootSpan };
    }
    return undefined;
  }

  function finalizeTrace(sessionKey: string): void {
    const active = activeTraces.get(sessionKey);
    if (!active) return;

    endChildSpans(active, `finalize sessionKey=${sessionKey}`);

    let outputText = "";
    if (active.output) {
      outputText = active.output.output;
    } else if (active.agentEnd?.messages?.length) {
      const last = [...active.agentEnd.messages]
        .reverse()
        .find((m) => (m as Record<string, unknown>)?.role === "assistant");
      if (last) outputText = safeStringify(last);
    }

    const agentEnd = active.agentEnd;
    if (outputText) {
      active.rootSpan.setAttribute("output.value", outputText);
      active.rootSpan.setAttribute("output.mime_type", "text/plain");
    }

    const model = active.model ?? active.costMeta.model;
    const provider = active.provider ?? active.costMeta.provider;
    if (model) active.rootSpan.setAttribute("llm.model_name", model);
    if (provider) active.rootSpan.setAttribute("llm.provider", provider);
    if (active.channelId) active.rootSpan.setAttribute("metadata.channel", active.channelId);
    if (active.trigger) active.rootSpan.setAttribute("metadata.trigger", active.trigger);

    const usage = hasUsageFields(active.usage) ? active.usage : (hasCostUsageFields(active.costMeta) ? {
      input: active.costMeta.usageInput,
      output: active.costMeta.usageOutput,
      total: active.costMeta.usageTotal,
    } : null);
    if (usage) {
      if (usage.input != null) active.rootSpan.setAttribute("llm.token_count.prompt", usage.input);
      if (usage.output != null) active.rootSpan.setAttribute("llm.token_count.completion", usage.output);
      if (usage.total != null) active.rootSpan.setAttribute("llm.token_count.total", usage.total);
    }

    if (active.costMeta.costUsd != null) {
      active.rootSpan.setAttribute("metadata.cost_usd", active.costMeta.costUsd);
    }

    if (agentEnd?.error) {
      active.rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: agentEnd.error });
    } else {
      active.rootSpan.setStatus({ code: SpanStatusCode.OK });
    }

    active.rootSpan.end();
    forgetSubagentSpanHostsByActive(active);
    activeTraces.delete(sessionKey);
    forgetSessionCorrelation(sessionKey);
  }

  // =========================================================================
  // Register ALL hooks NOW (during register() phase) — not in start().
  // api.on() only works with the api reference from the register() call.
  // The isReady() guard ensures we don't create spans before OTEL initializes.
  // =========================================================================

  registerLlmHooks({
    api,
    activeTraces,
    isReady,
    rememberSessionCorrelation,
    closeActiveTrace,
    forgetSessionCorrelation,
    applyContextMeta,
    warn: (msg) => log.warn(msg),
    formatError,
  });

  registerToolHooks({
    api,
    activeTraces,
    isReady,
    sessionByAgentId,
    getLastActiveSessionKey: () => lastActiveSessionKey,
    rememberSessionCorrelation,
    resolveSessionSpanContainer,
    warnMissingAfterToolSessionKey,
    nextSpanSeq: () => ++spanSeq,
    warn: (msg) => log.warn(msg),
    formatError,
  });

  registerSubagentHooks({
    api,
    isReady,
    rememberSessionCorrelation,
    resolveSubagentSpanContainer,
    getSubagentSpanHost,
    rememberSubagentSpanHost,
    forgetSubagentSpanHost,
    warn: (msg) => log.warn(msg),
    formatError,
  });

  // Hook: agent_end — finalize trace
  api.on("agent_end", (event: any, agentCtx: any) => {
    if (!isReady()) return;
    const sessionKey = agentCtx.sessionKey;
    if (!sessionKey) return;
    rememberSessionCorrelation(sessionKey, agentCtx.agentId);

    const active = activeTraces.get(sessionKey);
    if (!active) return;

    applyContextMeta(active, agentCtx as Record<string, unknown>);

    for (const [, toolSpan] of active.toolSpans) {
      try { toolSpan.end(); } catch {}
    }
    active.toolSpans.clear();
    for (const [, subagentSpan] of active.subagentSpans) {
      try { subagentSpan.end(); } catch {}
    }
    active.subagentSpans.clear();

    active.agentEnd = {
      success: event.success,
      error: typeof event.error === "string" ? sanitizeString(event.error) : event.error,
      durationMs: event.durationMs,
      messages: (sanitizeValue(
        ((event as Record<string, unknown>).messages as unknown[]) ?? [],
      ) as unknown[]) ?? [],
    };

    const rootRef = active.rootSpan;
    queueMicrotask(() => {
      const current = activeTraces.get(sessionKey);
      if (current && current.rootSpan === rootRef) finalizeTrace(sessionKey);
    });
  });

  console.log("[phoenix-otel] hooks registered in register() phase");

  return {
    id: PHOENIX_PLUGIN_ID,
    async start(ctx) {
      log = {
        info: ctx.logger.info.bind(ctx.logger),
        warn: ctx.logger.warn.bind(ctx.logger),
      };

      const runtimeCfg = parsePhoenixPluginConfig(ctx.config);
      const cfg: PhoenixPluginConfig = { ...pluginConfig };
      for (const [key, value] of Object.entries(runtimeCfg)) {
        if (value !== undefined) (cfg as Record<string, unknown>)[key] = value;
      }

      if (cfg.enabled === false) return;

      const endpoint = cfg.endpoint ?? process.env.PHOENIX_HOST ?? DEFAULT_ENDPOINT;
      const apiKey = cfg.apiKey ?? process.env.PHOENIX_API_KEY;
      const projectName = cfg.projectName ?? process.env.PHOENIX_PROJECT_NAME ?? DEFAULT_PROJECT_NAME;
      const serviceName = cfg.serviceName ?? DEFAULT_SERVICE_NAME;

      staleTraceCleanupEnabled = cfg.staleTraceCleanupEnabled !== false;
      staleTraceTimeoutMs = Math.max(
        1000, asNonNegativeNumber(cfg.staleTraceTimeoutMs) ?? DEFAULT_STALE_TRACE_TIMEOUT_MS,
      );
      staleSweepIntervalMs = Math.max(
        1000, asNonNegativeNumber(cfg.staleSweepIntervalMs) ?? DEFAULT_STALE_SWEEP_INTERVAL_MS,
      );

      // Initialize OTEL — after this, isReady() returns true and hooks create spans
      initOtel({ endpoint, apiKey, projectName, serviceName });
      otelReady = true;

      // Diagnostic: model.usage
      const unsubscribeDiagnostics = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        if (evt.type !== "model.usage") return;
        const sessionKey = evt.sessionKey;
        if (!sessionKey) return;
        const active = activeTraces.get(sessionKey);
        if (!active) return;

        if (evt.costUsd !== undefined) active.costMeta.costUsd = evt.costUsd;
        if (evt.context?.limit !== undefined) active.costMeta.contextLimit = evt.context.limit;
        if (evt.context?.used !== undefined) active.costMeta.contextUsed = evt.context.used;
        if (evt.model) active.costMeta.model = evt.model;
        if (evt.provider) active.costMeta.provider = normalizeProvider(evt.provider) ?? evt.provider;
        if (evt.durationMs !== undefined) active.costMeta.durationMs = evt.durationMs;
        if (evt.usage) {
          active.costMeta.usageInput = evt.usage.input;
          active.costMeta.usageOutput = evt.usage.output;
          active.costMeta.usageCacheRead = evt.usage.cacheRead;
          active.costMeta.usageCacheWrite = evt.usage.cacheWrite;
          active.costMeta.usageTotal = evt.usage.total;
        }
      });

      // Stale trace cleanup
      const sweepInterval = staleTraceCleanupEnabled
        ? setInterval(() => {
            const now = Date.now();
            for (const [key, active] of activeTraces) {
              if (now - active.lastActivityAt > staleTraceTimeoutMs) {
                endChildSpans(active, `stale cleanup sessionKey=${key}`);
                active.rootSpan.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: "Trace exceeded maximum inactivity threshold",
                });
                active.rootSpan.setAttribute("metadata.stale_cleanup", true);
                active.rootSpan.end();
                forgetSubagentSpanHostsByActive(active);
                activeTraces.delete(key);
                forgetSessionCorrelation(key);
              }
            }
          }, staleSweepIntervalMs)
        : null;

      cleanup = () => {
        unsubscribeDiagnostics();
        if (sweepInterval) clearInterval(sweepInterval);
      };

      log.info(
        `phoenix: exporting traces to "${projectName}" at ${endpoint} (staleCleanup=${staleTraceCleanupEnabled ? "on" : "off"}, staleTimeoutMs=${staleTraceTimeoutMs})`,
      );
    },

    async stop() {
      otelReady = false;
      cleanup?.();
      cleanup = null;

      for (const [sessionKey, active] of activeTraces) {
        closeActiveTrace(active, `service stop sessionKey=${sessionKey}`);
      }
      activeTraces.clear();
      sessionByAgentId.clear();
      lastActiveSessionKey = undefined;

      await forceFlush();
      await shutdownOtel();
      log.info("phoenix: stopped");
    },
  } satisfies OpenClawPluginService;
}
