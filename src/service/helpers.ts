import type { ActiveTrace } from "../types.js";

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveChannelId(ctx: Record<string, unknown>): string | undefined {
  return asNonEmptyString(ctx.channelId) ?? asNonEmptyString(ctx.messageProvider);
}

export function resolveTrigger(ctx: Record<string, unknown>): string | undefined {
  return asNonEmptyString(ctx.trigger);
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function normalizeProvider(value: unknown): string | undefined {
  const raw = asNonEmptyString(value);
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  if (
    normalized === "openai-codex" ||
    normalized === "openai_codex" ||
    normalized === "codex" ||
    (normalized.includes("openai") && normalized.includes("codex"))
  ) {
    return "openai";
  }
  return normalized;
}

export function hasUsageFields(usage: ActiveTrace["usage"]): boolean {
  return (
    usage.input != null ||
    usage.output != null ||
    usage.cacheRead != null ||
    usage.cacheWrite != null ||
    usage.total != null
  );
}

export function hasCostUsageFields(costMeta: ActiveTrace["costMeta"]): boolean {
  return (
    costMeta.usageInput != null ||
    costMeta.usageOutput != null ||
    costMeta.usageCacheRead != null ||
    costMeta.usageCacheWrite != null ||
    costMeta.usageTotal != null
  );
}

export function resolveToolCallId(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  return asNonEmptyString(event.toolCallId) ?? asNonEmptyString(ctx.toolCallId);
}

export function resolveRunId(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): string | undefined {
  return asNonEmptyString(event.runId) ?? asNonEmptyString(ctx.runId);
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Safely stringify a value, truncating to avoid huge spans. */
export function safeStringify(value: unknown, maxLen = 64000): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str && str.length > maxLen ? str.slice(0, maxLen) + "...[truncated]" : (str ?? "");
  } catch {
    return String(value);
  }
}
