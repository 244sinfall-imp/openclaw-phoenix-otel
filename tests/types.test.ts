import { describe, it, expect } from "vitest";
import { parsePhoenixPluginConfig } from "../src/types.js";

describe("parsePhoenixPluginConfig", () => {
  it("parses a valid full config", () => {
    const result = parsePhoenixPluginConfig({
      enabled: true,
      endpoint: "https://phoenix.example.com",
      apiKey: "sk-test",
      projectName: "my-project",
      serviceName: "my-service",
      staleTraceTimeoutMs: 10000,
      staleSweepIntervalMs: 5000,
      staleTraceCleanupEnabled: false,
    });
    expect(result).toEqual({
      enabled: true,
      endpoint: "https://phoenix.example.com",
      apiKey: "sk-test",
      projectName: "my-project",
      serviceName: "my-service",
      staleTraceTimeoutMs: 10000,
      staleSweepIntervalMs: 5000,
      staleTraceCleanupEnabled: false,
    });
  });

  it("parses a partial config", () => {
    const result = parsePhoenixPluginConfig({
      endpoint: "https://phoenix.example.com",
    });
    expect(result.endpoint).toBe("https://phoenix.example.com");
    expect(result.apiKey).toBeUndefined();
    expect(result.enabled).toBeUndefined();
  });

  it("returns all undefined for empty object", () => {
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

  it("returns all undefined for null input", () => {
    const result = parsePhoenixPluginConfig(null);
    expect(result.endpoint).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
  });

  it("returns all undefined for undefined input", () => {
    const result = parsePhoenixPluginConfig(undefined);
    expect(result.endpoint).toBeUndefined();
  });

  it("ignores wrong types for fields", () => {
    const result = parsePhoenixPluginConfig({
      enabled: "yes",
      endpoint: 123,
      apiKey: true,
      projectName: [],
      staleTraceTimeoutMs: "fast",
      staleTraceCleanupEnabled: 1,
    });
    expect(result.enabled).toBeUndefined();
    expect(result.endpoint).toBeUndefined();
    expect(result.apiKey).toBeUndefined();
    expect(result.projectName).toBeUndefined();
    expect(result.staleTraceTimeoutMs).toBeUndefined();
    expect(result.staleTraceCleanupEnabled).toBeUndefined();
  });

  it("trims whitespace from string fields", () => {
    const result = parsePhoenixPluginConfig({
      endpoint: "  https://phoenix.example.com  ",
      apiKey: "  sk-test  ",
    });
    expect(result.endpoint).toBe("https://phoenix.example.com");
    expect(result.apiKey).toBe("sk-test");
  });

  it("returns undefined for whitespace-only strings", () => {
    const result = parsePhoenixPluginConfig({
      endpoint: "   ",
      apiKey: "",
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

  it("handles array input as empty config", () => {
    const result = parsePhoenixPluginConfig([1, 2, 3]);
    expect(result.endpoint).toBeUndefined();
  });
});
