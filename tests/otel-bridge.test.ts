import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock OTEL SDK modules — must use actual class syntax for `new` to work
const mockForceFlush = vi.fn(async () => {});
const mockShutdown = vi.fn(async () => {});
const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  spanContext: vi.fn(() => ({ traceId: "abc", spanId: "def", traceFlags: 1 })),
  isRecording: vi.fn(() => true),
  recordException: vi.fn(),
  updateName: vi.fn(),
  addEvent: vi.fn(),
  addLink: vi.fn(),
};
const mockTracer = { startSpan: vi.fn(() => mockSpan) };
const mockProviderInstance = {
  getTracer: vi.fn(() => mockTracer),
  forceFlush: mockForceFlush,
  shutdown: mockShutdown,
};

let capturedExporterConfig: any = null;
let capturedResourceAttrs: any = null;

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => {
  return {
    OTLPTraceExporter: class MockOTLPTraceExporter {
      constructor(config: any) {
        capturedExporterConfig = config;
      }
    },
  };
});

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: (attrs: any) => {
    capturedResourceAttrs = attrs;
    return { attributes: attrs };
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: class MockBatchSpanProcessor {
    constructor() {}
  },
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class MockNodeTracerProvider {
    constructor() {}
    getTracer() { return mockTracer; }
    forceFlush() { return mockForceFlush(); }
    shutdown() { return mockShutdown(); }
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

// Import after mocks are set up
import * as otelBridge from "../src/service/otel-bridge.js";

describe("otel-bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedExporterConfig = null;
    capturedResourceAttrs = null;
    // Shutdown between tests to reset internal state
  });

  afterEach(async () => {
    await otelBridge.shutdown();
  });

  describe("getTracer", () => {
    it("returns null before initialization", async () => {
      await otelBridge.shutdown(); // ensure clean state
      expect(otelBridge.getTracer()).toBeNull();
    });

    it("returns tracer after initOtel", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      expect(otelBridge.getTracer()).not.toBeNull();
    });
  });

  describe("initOtel", () => {
    it("appends /v1/traces to endpoint", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      expect(capturedExporterConfig.url).toBe("https://phoenix.example.com/v1/traces");
    });

    it("strips trailing slashes from endpoint", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com///",
        projectName: "test",
        serviceName: "test-svc",
      });
      expect(capturedExporterConfig.url).toBe("https://phoenix.example.com/v1/traces");
    });

    it("sets Authorization header when apiKey provided", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        apiKey: "sk-test-key",
        projectName: "test",
        serviceName: "test-svc",
      });
      expect(capturedExporterConfig.headers).toEqual({ Authorization: "Bearer sk-test-key" });
    });

    it("does not set Authorization header when no apiKey", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      expect(capturedExporterConfig.headers).toEqual({});
    });

    it("creates resource with service name and project name", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "my-project",
        serviceName: "my-svc",
      });
      expect(capturedResourceAttrs).toEqual({
        "service.name": "my-svc",
        "openinference.project.name": "my-project",
      });
    });
  });

  describe("startRootSpan", () => {
    it("throws when OTEL not initialized", async () => {
      await otelBridge.shutdown();
      expect(() => otelBridge.startRootSpan("test")).toThrow("OTEL not initialized");
    });

    it("creates a span with name and attributes", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      const span = otelBridge.startRootSpan("test-span", { key: "value" });
      expect(span).toBeDefined();
      expect(mockTracer.startSpan).toHaveBeenCalledWith("test-span", { attributes: { key: "value" } });
    });
  });

  describe("startChildSpan", () => {
    it("creates a child span under parent context", () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      const parent = otelBridge.startRootSpan("parent");
      otelBridge.startChildSpan(parent as any, "child", { attributes: { "tool.name": "exec" } });
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(2);
      expect(mockTracer.startSpan).toHaveBeenLastCalledWith(
        "child",
        { attributes: { "tool.name": "exec" } },
        expect.anything(),
      );
    });
  });

  describe("forceFlush", () => {
    it("calls provider.forceFlush", async () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      await otelBridge.forceFlush();
      expect(mockForceFlush).toHaveBeenCalled();
    });

    it("is a no-op when not initialized", async () => {
      await otelBridge.shutdown();
      await otelBridge.forceFlush(); // should not throw
    });
  });

  describe("shutdown", () => {
    it("calls provider.shutdown and nulls tracer", async () => {
      otelBridge.initOtel({
        endpoint: "https://phoenix.example.com",
        projectName: "test",
        serviceName: "test-svc",
      });
      expect(otelBridge.getTracer()).not.toBeNull();
      await otelBridge.shutdown();
      expect(mockShutdown).toHaveBeenCalled();
      expect(otelBridge.getTracer()).toBeNull();
    });

    it("is a no-op when not initialized", async () => {
      await otelBridge.shutdown(); // ensure clean
      await otelBridge.shutdown(); // should not throw
    });
  });
});
