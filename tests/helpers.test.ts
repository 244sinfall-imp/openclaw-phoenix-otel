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
  asNonNegativeNumber,
  resolveToolCallId,
  resolveRunId,
} from "../src/service/helpers.js";

describe("normalizeProvider", () => {
  it("returns 'openai' for 'openai-codex'", () => {
    expect(normalizeProvider("openai-codex")).toBe("openai");
  });

  it("returns 'openai' for 'openai_codex'", () => {
    expect(normalizeProvider("openai_codex")).toBe("openai");
  });

  it("returns 'openai' for 'codex'", () => {
    expect(normalizeProvider("codex")).toBe("openai");
  });

  it("returns 'openai' for 'OpenAI-Codex' (case insensitive)", () => {
    expect(normalizeProvider("OpenAI-Codex")).toBe("openai");
  });

  it("returns 'anthropic' for 'anthropic'", () => {
    expect(normalizeProvider("anthropic")).toBe("anthropic");
  });

  it("returns 'openai' for 'openai'", () => {
    expect(normalizeProvider("openai")).toBe("openai");
  });

  it("returns undefined for null", () => {
    expect(normalizeProvider(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeProvider(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeProvider("")).toBeUndefined();
  });

  it("returns undefined for non-string", () => {
    expect(normalizeProvider(42)).toBeUndefined();
  });

  it("lowercases the provider name", () => {
    expect(normalizeProvider("Anthropic")).toBe("anthropic");
  });
});

describe("safeStringify", () => {
  it("returns a string as-is", () => {
    expect(safeStringify("hello")).toBe("hello");
  });

  it("stringifies objects", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("stringifies arrays", () => {
    expect(safeStringify([1, 2])).toBe("[1,2]");
  });

  it("truncates at maxLen", () => {
    const result = safeStringify("x".repeat(100), 50);
    expect(result).toBe("x".repeat(50) + "...[truncated]");
  });

  it("handles circular references gracefully", () => {
    const obj: any = {};
    obj.self = obj;
    const result = safeStringify(obj);
    expect(typeof result).toBe("string");
  });

  it("returns empty string for null", () => {
    expect(safeStringify(null)).toBe("null");
  });

  it("handles undefined", () => {
    expect(safeStringify(undefined)).toBe("");
  });
});

describe("resolveChannelId", () => {
  it("prefers channelId over messageProvider", () => {
    expect(resolveChannelId({ channelId: "ch1", messageProvider: "mp1" })).toBe("ch1");
  });

  it("falls back to messageProvider", () => {
    expect(resolveChannelId({ messageProvider: "mp1" })).toBe("mp1");
  });

  it("returns undefined for empty context", () => {
    expect(resolveChannelId({})).toBeUndefined();
  });

  it("returns undefined for empty string channelId", () => {
    expect(resolveChannelId({ channelId: "" })).toBeUndefined();
  });
});

describe("resolveTrigger", () => {
  it("extracts trigger from context", () => {
    expect(resolveTrigger({ trigger: "slash_command" })).toBe("slash_command");
  });

  it("returns undefined for missing trigger", () => {
    expect(resolveTrigger({})).toBeUndefined();
  });

  it("returns undefined for non-string trigger", () => {
    expect(resolveTrigger({ trigger: 42 })).toBeUndefined();
  });
});

describe("hasUsageFields", () => {
  it("returns true when input is set", () => {
    expect(hasUsageFields({ input: 100 })).toBe(true);
  });

  it("returns true when output is set", () => {
    expect(hasUsageFields({ output: 50 })).toBe(true);
  });

  it("returns true when total is set", () => {
    expect(hasUsageFields({ total: 150 })).toBe(true);
  });

  it("returns true when cacheRead is set", () => {
    expect(hasUsageFields({ cacheRead: 10 })).toBe(true);
  });

  it("returns true when cacheWrite is set", () => {
    expect(hasUsageFields({ cacheWrite: 5 })).toBe(true);
  });

  it("returns false when all fields are undefined", () => {
    expect(hasUsageFields({})).toBe(false);
  });
});

describe("hasCostUsageFields", () => {
  it("returns true when usageInput is set", () => {
    expect(hasCostUsageFields({ usageInput: 100 })).toBe(true);
  });

  it("returns true when usageOutput is set", () => {
    expect(hasCostUsageFields({ usageOutput: 50 })).toBe(true);
  });

  it("returns true when usageTotal is set", () => {
    expect(hasCostUsageFields({ usageTotal: 150 })).toBe(true);
  });

  it("returns false when all fields are undefined", () => {
    expect(hasCostUsageFields({})).toBe(false);
  });
});

describe("formatError", () => {
  it("returns stack for Error objects", () => {
    const err = new Error("boom");
    expect(formatError(err)).toContain("boom");
    expect(formatError(err)).toContain("Error");
  });

  it("returns string as-is", () => {
    expect(formatError("some error")).toBe("some error");
  });

  it("JSON stringifies objects", () => {
    expect(formatError({ code: 42 })).toBe('{"code":42}');
  });

  it("handles null", () => {
    expect(formatError(null)).toBe("null");
  });
});

describe("asNonEmptyString", () => {
  it("returns a non-empty string", () => {
    expect(asNonEmptyString("hello")).toBe("hello");
  });

  it("returns undefined for empty string", () => {
    expect(asNonEmptyString("")).toBeUndefined();
  });

  it("returns undefined for non-strings", () => {
    expect(asNonEmptyString(42)).toBeUndefined();
    expect(asNonEmptyString(null)).toBeUndefined();
    expect(asNonEmptyString(undefined)).toBeUndefined();
    expect(asNonEmptyString({})).toBeUndefined();
  });
});

describe("asNonNegativeNumber", () => {
  it("returns a positive number", () => {
    expect(asNonNegativeNumber(5)).toBe(5);
  });

  it("returns 0", () => {
    expect(asNonNegativeNumber(0)).toBe(0);
  });

  it("returns undefined for negative", () => {
    expect(asNonNegativeNumber(-1)).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    expect(asNonNegativeNumber(NaN)).toBeUndefined();
  });

  it("returns undefined for Infinity", () => {
    expect(asNonNegativeNumber(Infinity)).toBeUndefined();
  });

  it("returns undefined for non-numbers", () => {
    expect(asNonNegativeNumber("5")).toBeUndefined();
  });
});

describe("resolveToolCallId", () => {
  it("prefers event.toolCallId", () => {
    expect(resolveToolCallId({ toolCallId: "e1" }, { toolCallId: "c1" })).toBe("e1");
  });

  it("falls back to ctx.toolCallId", () => {
    expect(resolveToolCallId({}, { toolCallId: "c1" })).toBe("c1");
  });

  it("returns undefined when neither present", () => {
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
