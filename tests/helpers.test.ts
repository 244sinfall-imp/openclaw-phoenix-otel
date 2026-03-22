import { describe, it, expect } from "vitest";
import {
  normalizeProvider,
  safeStringify,
  resolveChannelId,
  resolveTrigger,
  hasUsageFields,
  hasCostUsageFields,
  formatError,
  asNonEmptyString,
  resolveToolCallId,
  resolveRunId,
} from "../src/service/helpers.js";

describe("asNonEmptyString", () => {
  it("returns string for non-empty string", () => {
    expect(asNonEmptyString("hello")).toBe("hello");
  });
  it("returns undefined for empty string", () => {
    expect(asNonEmptyString("")).toBeUndefined();
  });
  it("returns undefined for non-string types", () => {
    expect(asNonEmptyString(42)).toBeUndefined();
    expect(asNonEmptyString(null)).toBeUndefined();
    expect(asNonEmptyString(undefined)).toBeUndefined();
    expect(asNonEmptyString(true)).toBeUndefined();
    expect(asNonEmptyString({})).toBeUndefined();
  });
});

describe("normalizeProvider", () => {
  it("normalizes standard providers to lowercase", () => {
    expect(normalizeProvider("Anthropic")).toBe("anthropic");
    expect(normalizeProvider("OpenAI")).toBe("openai");
    expect(normalizeProvider("GOOGLE")).toBe("google");
  });
  it('normalizes codex variants to "openai"', () => {
    expect(normalizeProvider("openai-codex")).toBe("openai");
    expect(normalizeProvider("openai_codex")).toBe("openai");
    expect(normalizeProvider("codex")).toBe("openai");
    expect(normalizeProvider("OpenAI-Codex")).toBe("openai");
  });
  it("returns undefined for empty/null/non-string", () => {
    expect(normalizeProvider("")).toBeUndefined();
    expect(normalizeProvider(null)).toBeUndefined();
    expect(normalizeProvider(undefined)).toBeUndefined();
    expect(normalizeProvider(42)).toBeUndefined();
    expect(normalizeProvider("   ")).toBeUndefined();
  });
});

describe("resolveChannelId", () => {
  it("prefers channelId over messageProvider", () => {
    expect(resolveChannelId({ channelId: "signal", messageProvider: "telegram" })).toBe("signal");
  });
  it("falls back to messageProvider", () => {
    expect(resolveChannelId({ messageProvider: "telegram" })).toBe("telegram");
  });
  it("returns undefined when neither exists", () => {
    expect(resolveChannelId({})).toBeUndefined();
  });
  it("skips empty strings", () => {
    expect(resolveChannelId({ channelId: "", messageProvider: "slack" })).toBe("slack");
  });
});

describe("resolveTrigger", () => {
  it("returns trigger value", () => {
    expect(resolveTrigger({ trigger: "cron" })).toBe("cron");
  });
  it("returns undefined for missing trigger", () => {
    expect(resolveTrigger({})).toBeUndefined();
  });
});

describe("hasUsageFields", () => {
  it("returns true when any field is set", () => {
    expect(hasUsageFields({ input: 100 })).toBe(true);
    expect(hasUsageFields({ output: 50 })).toBe(true);
    expect(hasUsageFields({ total: 150 })).toBe(true);
    expect(hasUsageFields({ cacheRead: 10 })).toBe(true);
    expect(hasUsageFields({ cacheWrite: 5 })).toBe(true);
  });
  it("returns false when all fields are undefined", () => {
    expect(hasUsageFields({})).toBe(false);
  });
});

describe("hasCostUsageFields", () => {
  it("returns true when any usage field is set", () => {
    expect(hasCostUsageFields({ usageInput: 100 })).toBe(true);
    expect(hasCostUsageFields({ usageOutput: 50 })).toBe(true);
    expect(hasCostUsageFields({ usageTotal: 150 })).toBe(true);
  });
  it("returns false when no usage fields set", () => {
    expect(hasCostUsageFields({})).toBe(false);
    expect(hasCostUsageFields({ costUsd: 0.05 })).toBe(false);
  });
});

describe("formatError", () => {
  it("formats Error objects with stack", () => {
    const err = new Error("test error");
    const result = formatError(err);
    expect(result).toContain("test error");
  });
  it("returns strings as-is", () => {
    expect(formatError("plain error")).toBe("plain error");
  });
  it("JSON-stringifies objects", () => {
    expect(formatError({ code: 42 })).toBe('{"code":42}');
  });
  it("handles non-serializable values", () => {
    const circular: any = {};
    circular.self = circular;
    expect(formatError(circular)).toBe("[object Object]");
  });
});

describe("safeStringify", () => {
  it("stringifies objects", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });
  it("returns strings as-is", () => {
    expect(safeStringify("hello")).toBe("hello");
  });
  it("truncates at maxLen", () => {
    const result = safeStringify("a".repeat(100), 50);
    expect(result).toHaveLength(50 + "...[truncated]".length);
    expect(result).toContain("...[truncated]");
  });
  it("handles circular references", () => {
    const circular: any = {};
    circular.self = circular;
    const result = safeStringify(circular);
    expect(result).toBe("[object Object]");
  });
  it("handles null", () => {
    expect(safeStringify(null)).toBe("null");
  });
  it("returns empty string for undefined (JSON.stringify returns undefined)", () => {
    // JSON.stringify(undefined) === undefined, so falls back to ""
    expect(safeStringify(undefined)).toBe("");
  });
});

describe("resolveToolCallId", () => {
  it("prefers event.toolCallId", () => {
    expect(resolveToolCallId({ toolCallId: "ev1" }, { toolCallId: "ctx1" })).toBe("ev1");
  });
  it("falls back to ctx.toolCallId", () => {
    expect(resolveToolCallId({}, { toolCallId: "ctx1" })).toBe("ctx1");
  });
  it("returns undefined when neither has it", () => {
    expect(resolveToolCallId({}, {})).toBeUndefined();
  });
});

describe("resolveRunId", () => {
  it("prefers event.runId", () => {
    expect(resolveRunId({ runId: "r1" }, { runId: "r2" })).toBe("r1");
  });
  it("falls back to ctx.runId", () => {
    expect(resolveRunId({}, { runId: "r2" })).toBe("r2");
  });
});
