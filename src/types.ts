import type { Span } from "@opentelemetry/api";

export type PhoenixPluginConfig = {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  projectName?: string;
  serviceName?: string;
  staleTraceTimeoutMs?: number;
  staleSweepIntervalMs?: number;
  staleTraceCleanupEnabled?: boolean;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

export function parsePhoenixPluginConfig(raw: unknown): PhoenixPluginConfig {
  const cfg = asObject(raw);
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : undefined,
    endpoint: asOptionalString(cfg.endpoint),
    apiKey: asOptionalString(cfg.apiKey),
    projectName: asOptionalString(cfg.projectName),
    serviceName: asOptionalString(cfg.serviceName),
    staleTraceTimeoutMs: asOptionalNumber(cfg.staleTraceTimeoutMs),
    staleSweepIntervalMs: asOptionalNumber(cfg.staleSweepIntervalMs),
    staleTraceCleanupEnabled:
      typeof cfg.staleTraceCleanupEnabled === "boolean" ? cfg.staleTraceCleanupEnabled : undefined,
  };
}

/** Active trace state for a single agent run, keyed by sessionKey. */
export type ActiveTrace = {
  rootSpan: Span;
  llmSpan: Span | null;
  toolSpans: Map<string, Span>;
  toolSpanKeysByName: Map<string, string[]>;
  toolSpanSeq: number;
  completedToolCallIds: Set<string>;
  subagentSpans: Map<string, Span>;
  startedAt: number;
  lastActivityAt: number;
  costMeta: {
    costUsd?: number;
    contextLimit?: number;
    contextUsed?: number;
    model?: string;
    provider?: string;
    durationMs?: number;
    usageInput?: number;
    usageOutput?: number;
    usageCacheRead?: number;
    usageCacheWrite?: number;
    usageTotal?: number;
  };
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  model?: string;
  provider?: string;
  channelId?: string;
  trigger?: string;
  prompt?: string;
  output?: { output: string; lastAssistant?: unknown };
  agentEnd?: {
    success: boolean;
    error?: string;
    durationMs?: number;
    messages: unknown[];
  };
  agentId?: string;
  userId?: string;
};
