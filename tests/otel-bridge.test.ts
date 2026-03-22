import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock OTEL SDK classes before importing the module
const mockExporter = { shutdown: vi.fn() };
const mockProcessor = { shutdown: vi.fn() };
const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  spanContext: vi.fn(() => ({ traceId: "abc", spanId: "def", traceFlags: 1 })),
  isRecording: vi.fn(() => true),
  recordException: vi.fn(),
  updateName: vi.fn(),
  addEvent: vi.fn(),
};
const mockTracer = {
  startSpan: vi.fn(() => mockSpan),
};
const mockProvider = {
  getTracer: vi.fn(() => mockTracer),
  forceFlush: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
};

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class MockOTLPTraceExporter {
    url: string;
    headers: Record<string, string>;
    constructor(opts: any) {
      Object.assign(mockExporter, opts);
      this.url = opts.url;
      this.headers = opts.headers;
      return mockExporter as any;
    }
  },
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: any) => ({ attributes: attrs })),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: class MockBatchSpanProcessor {
    constructor() {
      return mockProcessor as any;
    }
  },
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class MockNodeTracerProvider {
    constructor(opts: any) {
      Object.assign(mockProvider, { _opts: opts });
      return mockProvider as any;
    }
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

// Import after mocks are set up
import { initOtel, getTracer, startRootSpan, startChildSpan, forceFlush, shutdown } from "../src/service/otel-bridge.js";
import { resourceFromAttributes } from "@opentelemetry/resources";

describe("otel-bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try { await shutdown(); } catch {}
  });

  describe("initOtel", () => {
    it("creates provider with correct config", () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test-project",
        serviceName: "test-service",
      });

      expect((mockExporter as any).url).toBe("https://phoenix.example.com/v1/traces");
      expect((mockExporter as any).headers).toEqual({});

      expect(resourceFromAttributes).toHaveBeenCalledWith({
        "service.name": "test-service",
        "openinference.project.name": "test-project",
      });

      expect(mockProvider.getTracer).toHaveBeenCalledWith("openclaw-phoenix-otel", "1.0.0");
    });

    it("appends /v1/traces to endpoint", () => {
      initOtel({
        endpoint: "https://phoenix.example.com/",
        projectName: "test",
        serviceName: "test",
      });

      expect((mockExporter as any).url).toBe("https://phoenix.example.com/v1/traces");
    });

    it("strips trailing slashes from endpoint", () => {
      initOtel({
        endpoint: "https://phoenix.example.com///",
        projectName: "test",
        serviceName: "test",
      });

      expect((mockExporter as any).url).toBe("https://phoenix.example.com/v1/traces");
    });

    it("sets Authorization header when apiKey provided", () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        apiKey: "sk-test-123",
        projectName: "test",
        serviceName: "test",
      });

      expect((mockExporter as any).headers).toEqual({
        Authorization: "Bearer sk-test-123",
      });
    });

    it("does not set Authorization header without apiKey", () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test",
      });

      expect((mockExporter as any).headers).toEqual({});
    });
  });

  describe("getTracer", () => {
    it("returns tracer after init", () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test",
      });
      expect(getTracer()).toBe(mockTracer);
    });
  });

  describe("startRootSpan", () => {
    it("creates span with name and attributes", () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test",
      });

      const span = startRootSpan("test-span", { "key": "value" });
      expect(mockTracer.startSpan).toHaveBeenCalledWith("test-span", {
        attributes: { key: "value" },
      });
      expect(span).toBe(mockSpan);
    });

    it("throws if OTEL not initialized", async () => {
      await shutdown();
      expect(() => startRootSpan("test")).toThrow("OTEL not initialized");
    });
  });

  describe("startChildSpan", () => {
    it("creates child span with parent context", () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test",
      });

      const parentSpan = startRootSpan("parent");
      startChildSpan(parentSpan, "child", {
        attributes: { "openinference.span.kind": "LLM" },
      });

      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2);
    });
  });

  describe("forceFlush", () => {
    it("calls provider.forceFlush", async () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test",
      });

      await forceFlush();
      expect(mockProvider.forceFlush).toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("calls provider.shutdown and clears state", async () => {
      initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test",
      });

      await shutdown();
      expect(mockProvider.shutdown).toHaveBeenCalled();
    });
  });
});
