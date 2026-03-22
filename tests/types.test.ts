import { describe, it, expect } from "vitest";
import { parsePhoenixPluginConfig } from "../src/types.js";

describe("parsePhoenixPluginConfig", () => {
  it("parses a full valid config", () => {
    const result = parsePhoenixPluginConfig({
      enabled: true,
      endpoint: "https://phoenix.example.com",
      apiKey: "sk-123",
      projectName: "my-project",
      serviceName: "my-service",
      staleTraceTimeoutMs: 60000,
      staleSweepIntervalMs: 10000,
      staleTraceCleanupEnabled: false,
    });
    expect(result).toEqual({
      enabled: true,
      endpoint: "https://phoenix.example.com",
      apiKey: "sk-123",
      projectName: "my-project",
      serviceName: "my-service",
      staleTraceTimeoutMs: 60000,
      staleSweepIntervalMs: 10000,
      staleTraceCleanupEnabled: false,
    });
  });

  it("returns undefined fields for empty object", () => {
    const result = parsePhoenixPluginConfig({});
    expect(result.enabled).toBeUndefined();
    expect(result.endpoint).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
    expect(result.projectName).toBeUndefined();
    expect(result.serviceName).toBeUndefined();
    expect(result.staleTraceTimeoutMs).toBeUndefined();
    expect(result.staleSweepIntervalMs).toBeUndefined();
    expect(result.staleTraceCleanupEnabled).toBeUndefined();
  });

  it("handles null input", () => {
    const result = parsePhoenixPluginConfig(null);
    expect(result.enabled).toBeUndefined();
    expect(result.endpoint).toBeUndefined();
  });

  it("handles undefined input", () => {
    const result = parsePhoenixPluginConfig(undefined);
    expect(result.enabled).toBeUndefined();
  });

  it("handles array input (not a plain object)", () => {
    const result = parsePhoenixPluginConfig([1, 2, 3]);
    expect(result.enabled).toBeUndefined();
  });

  it("ignores wrong types for string fields", () => {
    const result = parsePhoenixPluginConfig({
      endpoint: 42,
      apiKey: true,
      projectName: {},
    });
    expect(result.endpoint).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
    expect(result.projectName).toBeUndefined();
  });

  it("ignores wrong types for boolean fields", () => {
    const result = parsePhoenixPluginConfig({
      enabled: "yes",
      staleTraceCleanupEnabled: 1,
    });
    expect(result.enabled).toBeUndefined();
    expect(result.staleTraceCleanupEnabled).toBeUndefined();
  });

  it("ignores wrong types for number fields", () => {
    const result = parsePhoenixPluginConfig({
      staleTraceTimeoutMs: "60000",
      staleSweepIntervalMs: null,
    });
    expect(result.staleTraceTimeoutMs).toBeUndefined();
    expect(result.staleSweepIntervalMs).toBeUndefined();
  });

  it("trims whitespace from string fields", () => {
    const result = parsePhoenixPluginConfig({
      endpoint: "  https://example.com  ",
      projectName: "  my-project  ",
    });
    expect(result.endpoint).toBe("https://example.com");
    expect(result.projectName).toBe("my-project");
  });

  it("treats whitespace-only strings as undefined", () => {
    const result = parsePhoenixPluginConfig({
      endpoint: "   ",
      apiKey: "  ",
    });
    expect(result.endpoint).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
  });

  it("rejects NaN and Infinity for number fields", () => {
    const result = parsePhoenixPluginConfig({
      staleTraceTimeoutMs: NaN,
      staleSweepIntervalMs: Infinity,
    });
    expect(result.staleTraceTimeoutMs).toBeUndefined();
    expect(result.staleSweepIntervalMs).toBeUndefined();
  });

  it("parses partial config", () => {
    const result = parsePhoenixPluginConfig({
      enabled: true,
      projectName: "test",
    });
    expect(result.enabled).toBe(true);
    expect(result.projectName).toBe("test");
    expect(result.endpoint).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
  });
});
