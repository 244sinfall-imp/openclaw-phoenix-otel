import type { Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ActiveTrace } from "../../types.js";
import { asNonEmptyString, safeStringify } from "../helpers.js";
import { startChildSpan } from "../otel-bridge.js";
import { sanitizeString } from "../payload-sanitizer.js";

type SubagentHooksDeps = {
  api: OpenClawPluginApi;
  isReady: () => boolean;
  rememberSessionCorrelation: (sessionKey: string, agentId?: unknown) => void;
  resolveSubagentSpanContainer: (params: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    targetSessionKey?: string;
  }) => { sessionKey: string; active: ActiveTrace; parentSpan: Span } | undefined;
  getSubagentSpanHost: (
    sessionKey: string,
  ) => { hostSessionKey: string; active: ActiveTrace; span: Span } | undefined;
  rememberSubagentSpanHost: (
    sessionKey: string,
    hostSessionKey: string,
    active: ActiveTrace,
    span: Span,
  ) => void;
  forgetSubagentSpanHost: (sessionKey: string) => void;
  warn: (message: string) => void;
  formatError: (err: unknown) => string;
};

export function registerSubagentHooks(deps: SubagentHooksDeps): void {
  deps.api.on("subagent_spawning", (event: any, subagentCtx: any) => {
    if (!deps.isReady()) return;
    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;
    const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey =
      asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
    if (!childSessionKey) return;

    const existingHost = deps.getSubagentSpanHost(childSessionKey);
    if (existingHost) {
      existingHost.span.end();
      existingHost.active.subagentSpans.delete(childSessionKey);
      deps.forgetSubagentSpanHost(childSessionKey);
    }

    const host = deps.resolveSubagentSpanContainer({ requesterSessionKey, childSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    try {
      const span = startChildSpan(host.parentSpan, `subagent:${asNonEmptyString(eventObj.agentId) ?? "unknown"}`, {
        attributes: {
          "openinference.span.kind": "AGENT",
          "input.value": safeStringify({
            childSessionKey,
            agentId: eventObj.agentId,
            label: eventObj.label,
            mode: eventObj.mode,
          }),
          "input.mime_type": "application/json",
        },
      });
      host.active.subagentSpans.set(childSessionKey, span);
      deps.rememberSubagentSpanHost(childSessionKey, host.sessionKey, host.active, span);
    } catch (err) {
      deps.warn(
        `phoenix: subagent span creation failed (childSessionKey=${childSessionKey}): ${deps.formatError(err)}`,
      );
    }
  });

  deps.api.on("subagent_spawned", (event: any, subagentCtx: any) => {
    if (!deps.isReady()) return;
    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;
    const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey =
      asNonEmptyString(eventObj.childSessionKey) ?? asNonEmptyString(ctxObj.childSessionKey);
    if (!childSessionKey) return;

    const existingHost = deps.getSubagentSpanHost(childSessionKey);
    const host = existingHost
      ? { sessionKey: existingHost.hostSessionKey, active: existingHost.active, parentSpan: existingHost.span }
      : deps.resolveSubagentSpanContainer({ requesterSessionKey, childSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    let span = existingHost?.span ?? host.active.subagentSpans.get(childSessionKey);
    if (!span) {
      try {
        span = startChildSpan(host.parentSpan, `subagent:${asNonEmptyString(eventObj.agentId) ?? "unknown"}`, {
          attributes: {
            "openinference.span.kind": "AGENT",
            "input.value": safeStringify({
              childSessionKey,
              agentId: eventObj.agentId,
              mode: eventObj.mode,
            }),
            "input.mime_type": "application/json",
          },
        });
        host.active.subagentSpans.set(childSessionKey, span);
        deps.rememberSubagentSpanHost(childSessionKey, host.sessionKey, host.active, span);
      } catch (err) {
        deps.warn(
          `phoenix: subagent span creation failed on spawn (childSessionKey=${childSessionKey}): ${deps.formatError(err)}`,
        );
        return;
      }
    }
  });

  deps.api.on("subagent_ended", (event: any, subagentCtx: any) => {
    if (!deps.isReady()) return;
    const eventObj = event as Record<string, unknown>;
    const ctxObj = subagentCtx as Record<string, unknown>;
    const requesterSessionKey = asNonEmptyString(ctxObj.requesterSessionKey);
    const childSessionKey = asNonEmptyString(ctxObj.childSessionKey);
    const targetSessionKey = asNonEmptyString(eventObj.targetSessionKey) ?? childSessionKey;

    const existingHost = targetSessionKey ? deps.getSubagentSpanHost(targetSessionKey) : undefined;
    const host = existingHost
      ? { sessionKey: existingHost.hostSessionKey, active: existingHost.active, parentSpan: existingHost.span }
      : deps.resolveSubagentSpanContainer({ requesterSessionKey, childSessionKey, targetSessionKey });
    if (!host) return;

    deps.rememberSessionCorrelation(host.sessionKey);
    host.active.lastActivityAt = Date.now();

    let span = existingHost?.span ?? (targetSessionKey ? host.active.subagentSpans.get(targetSessionKey) : undefined);
    if (!span) {
      try {
        span = startChildSpan(host.parentSpan, `subagent:${asNonEmptyString(eventObj.targetKind) ?? "unknown"}`, {
          attributes: {
            "openinference.span.kind": "AGENT",
            "input.value": safeStringify({
              targetSessionKey,
              targetKind: eventObj.targetKind,
              reason: eventObj.reason,
            }),
            "input.mime_type": "application/json",
          },
        });
        if (targetSessionKey) {
          host.active.subagentSpans.set(targetSessionKey, span);
          deps.rememberSubagentSpanHost(targetSessionKey, host.sessionKey, host.active, span);
        }
      } catch (err) {
        deps.warn(
          `phoenix: subagent span creation failed on end (targetSessionKey=${targetSessionKey ?? "unknown"}): ${deps.formatError(err)}`,
        );
        return;
      }
    }

    // Set output
    const error = asNonEmptyString(eventObj.error);
    if (error) {
      const sanitizedError = sanitizeString(error);
      span.setAttribute("output.value", safeStringify({ error: sanitizedError }));
      span.setStatus({ code: SpanStatusCode.ERROR, message: sanitizedError });
    } else {
      span.setAttribute("output.value", safeStringify({
        outcome: eventObj.outcome,
        reason: eventObj.reason,
      }));
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.setAttribute("output.mime_type", "application/json");

    span.end();
    if (targetSessionKey) {
      host.active.subagentSpans.delete(targetSessionKey);
      deps.forgetSubagentSpanHost(targetSessionKey);
    }
  });
}
