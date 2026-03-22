import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ActiveTrace } from "../../types.js";
import { asNonEmptyString, resolveRunId, resolveToolCallId, safeStringify } from "../helpers.js";
import { startChildSpan } from "../otel-bridge.js";
import { sanitizeString, sanitizeValue } from "../payload-sanitizer.js";

type ToolHooksDeps = {
  api: OpenClawPluginApi;
  activeTraces: Map<string, ActiveTrace>;
  isReady: () => boolean;
  sessionByAgentId: Map<string, string>;
  getLastActiveSessionKey: () => string | undefined;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  resolveSessionSpanContainer: (
    sessionKey: string,
  ) => { sessionKey: string; active: ActiveTrace; parentSpan: Span } | undefined;
  warnMissingAfterToolSessionKey: (fallbackMode: string) => void;
  nextSpanSeq: () => number;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export function registerToolHooks(deps: ToolHooksDeps): void {
  deps.api.on("before_tool_call", (event: any, toolCtx: any) => {
    if (!deps.isReady()) return;
    const sessionKey = toolCtx.sessionKey;
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, toolCtx.agentId);

    const container = deps.resolveSessionSpanContainer(sessionKey);
    if (!container) return;
    const active = container.active;
    active.lastActivityAt = Date.now();

    const eventObj = event as Record<string, unknown>;
    const ctxObj = toolCtx as Record<string, unknown>;
    const toolCallId = resolveToolCallId(eventObj, ctxObj);

    const sanitizedInput = sanitizeValue(event.params);

    let toolSpan: Span;
    try {
      toolSpan = startChildSpan(container.parentSpan, event.toolName, {
        attributes: {
          "openinference.span.kind": "TOOL",
          "tool.name": event.toolName,
          "input.value": safeStringify(sanitizedInput),
          "input.mime_type": "application/json",
        },
      });
    } catch (err) {
      deps.warn(
        `phoenix: tool span creation failed (sessionKey=${sessionKey}, tool=${event.toolName}): ${deps.formatError(err)}`,
      );
      return;
    }

    const spanKey = toolCallId
      ? `session:${sessionKey}:toolcall:${toolCallId}`
      : `session:${sessionKey}:${event.toolName}:${deps.nextSpanSeq()}`;

    if (toolCallId) {
      const existing = active.toolSpans.get(spanKey);
      if (existing) {
        existing.end();
        active.toolSpans.delete(spanKey);
      }
    }
    active.toolSpans.set(spanKey, toolSpan);
  });

  deps.api.on("after_tool_call", (event: any, toolCtx: any) => {
    if (!deps.isReady()) return;
    const eventObj = event as Record<string, unknown>;
    const ctxObj = toolCtx as Record<string, unknown>;
    const toolCallId = resolveToolCallId(eventObj, ctxObj);

    let sessionKey = toolCtx.sessionKey;
    let fallbackMode: "agentId" | "single active trace" | "last active session" | undefined;
    if (!sessionKey) {
      if (typeof toolCtx.agentId === "string" && toolCtx.agentId.length > 0) {
        const byAgentId = deps.sessionByAgentId.get(toolCtx.agentId);
        if (byAgentId && deps.activeTraces.has(byAgentId)) {
          sessionKey = byAgentId;
          fallbackMode = "agentId";
        }
      }
      if (!sessionKey && deps.activeTraces.size === 1) {
        sessionKey = deps.activeTraces.keys().next().value as string | undefined;
        fallbackMode = "single active trace";
      } else if (!sessionKey) {
        const lastActiveSessionKey = deps.getLastActiveSessionKey();
        if (lastActiveSessionKey && deps.activeTraces.has(lastActiveSessionKey)) {
          sessionKey = lastActiveSessionKey;
          fallbackMode = "last active session";
        }
      }
      if (sessionKey && fallbackMode) {
        deps.warnMissingAfterToolSessionKey(fallbackMode);
      }
    }
    if (!sessionKey) return;
    deps.rememberSessionCorrelation(sessionKey, toolCtx.agentId);

    const container = deps.resolveSessionSpanContainer(sessionKey);
    if (!container) return;
    const active = container.active;
    active.lastActivityAt = Date.now();

    // Find matching tool span
    let matchedKey: string | undefined;
    let matchedSpan: Span | undefined;
    if (toolCallId) {
      const toolCallKey = `session:${sessionKey}:toolcall:${toolCallId}`;
      const toolCallSpan = active.toolSpans.get(toolCallKey);
      if (toolCallSpan) {
        matchedKey = toolCallKey;
        matchedSpan = toolCallSpan;
      }
    }
    if (!matchedSpan) {
      for (const [key, span] of active.toolSpans) {
        if (key.startsWith(`session:${sessionKey}:${event.toolName}:`)) {
          matchedKey = key;
          matchedSpan = span;
          break;
        }
      }
    }
    if (!matchedKey || !matchedSpan) return;

    // Set output
    if (event.error) {
      const sanitizedError = sanitizeString(event.error);
      matchedSpan.setAttribute("output.value", safeStringify({ error: sanitizedError }));
      matchedSpan.setStatus({ code: SpanStatusCode.ERROR, message: sanitizedError });
    } else if (event.result !== undefined) {
      const output =
        typeof event.result === "object" && event.result !== null
          ? event.result
          : { result: event.result };
      matchedSpan.setAttribute("output.value", safeStringify(sanitizeValue(output)));
    }
    matchedSpan.setAttribute("output.mime_type", "application/json");

    matchedSpan.setStatus({ code: event.error ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    matchedSpan.end();
    active.toolSpans.delete(matchedKey);
  });
}
