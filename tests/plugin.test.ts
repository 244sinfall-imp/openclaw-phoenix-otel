import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock openclaw/plugin-sdk ----
vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: () => ({}),
  onDiagnosticEvent: vi.fn(),
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

// ---- Mock otel-bridge ----
// Use module-scoped mutable state that can be controlled per-test
const mockSpan = () => ({
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
  spanContext: vi.fn(() => ({ traceId: "abc", spanId: "def", traceFlags: 1 })),
  isRecording: vi.fn(() => true),
});

const state = {
  initOtel: vi.fn(),
  getTracer: vi.fn(() => ({ startSpan: vi.fn() })),
  startRootSpan: vi.fn(() => mockSpan()),
  startChildSpan: vi.fn(() => mockSpan()),
  forceFlush: vi.fn(() => Promise.resolve()),
  shutdown: vi.fn(() => Promise.resolve()),
};

vi.mock("../src/service/otel-bridge.js", () => ({
  initOtel: (...args: any[]) => state.initOtel(...args),
  getTracer: (...args: any[]) => state.getTracer(...args),
  startRootSpan: (...args: any[]) => state.startRootSpan(...args),
  startChildSpan: (...args: any[]) => state.startChildSpan(...args),
  forceFlush: (...args: any[]) => state.forceFlush(...args),
  shutdown: (...args: any[]) => state.shutdown(...args),
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}));

// Flush microtasks helper
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

// Helper to create a mock API and capture handlers
function createMockApi(pluginConfig: unknown = {}) {
  const handlers = new Map<string, (...args: any[]) => void>();
  let registeredService: any = null;

  const api = {
    pluginConfig,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler);
    }),
    registerService: vi.fn((service: any) => {
      registeredService = service;
    }),
  };

  return {
    api,
    handlers,
    getService: () => registeredService,
    fire: (event: string, ...args: any[]) => {
      const handler = handlers.get(event);
      if (handler) handler(...args);
    },
  };
}

// Import plugin (uses hoisted mocks above)
import plugin from "../index.js";

describe("plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    state.initOtel = vi.fn();
    state.getTracer = vi.fn(() => ({ startSpan: vi.fn() }));
    state.startRootSpan = vi.fn(() => mockSpan());
    state.startChildSpan = vi.fn(() => mockSpan());
    state.forceFlush = vi.fn(() => Promise.resolve());
    state.shutdown = vi.fn(() => Promise.resolve());
  });

  it("has correct id and name", () => {
    expect(plugin.id).toBe("phoenix-otel");
    expect(plugin.name).toBe("Phoenix OTEL");
  });

  it("calls initOtel on register", () => {
    const { api } = createMockApi();
    plugin.register(api as any);
    expect(state.initOtel).toHaveBeenCalled();
  });

  it("registers all expected event handlers", () => {
    const { api } = createMockApi();
    plugin.register(api as any);
    expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
  });

  it("registers a service", () => {
    const { api } = createMockApi();
    plugin.register(api as any);
    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "phoenix-otel" })
    );
  });

  describe("llm_input → llm_output lifecycle", () => {
    it("creates root and LLM spans on llm_input", () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);

      fire("llm_input", {
        model: "gpt-4",
        provider: "openai",
        prompt: "Hello",
        systemPrompt: "You are helpful",
      }, {
        sessionKey: "sess-1",
        agentId: "agent-1",
      });

      expect(state.startRootSpan).toHaveBeenCalledWith(
        expect.stringContaining("gpt-4"),
        expect.objectContaining({
          "openinference.span.kind": "AGENT",
          "llm.model_name": "gpt-4",
        })
      );
      expect(state.startChildSpan).toHaveBeenCalled();
    });

    it("sets response content and token counts on llm_output", () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);

      fire("llm_input", {
        model: "gpt-4",
        provider: "openai",
        prompt: "Hello",
      }, { sessionKey: "sess-1" });

      fire("llm_output", {
        model: "gpt-4",
        provider: "openai",
        assistantTexts: ["World"],
        usage: { input: 10, output: 20, total: 30 },
      }, { sessionKey: "sess-1" });

      expect(llmSpan.setAttribute).toHaveBeenCalledWith("output.value", "World");
      expect(llmSpan.setAttribute).toHaveBeenCalledWith("output.mime_type", "text/plain");
      expect(llmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.prompt", 10);
      expect(llmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.completion", 20);
      expect(llmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.total", 30);
      expect(llmSpan.end).toHaveBeenCalled();
    });
  });

  describe("tool call lifecycle", () => {
    it("creates and completes tool spans", () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      const toolSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);
      state.startChildSpan.mockReturnValueOnce(toolSpan);

      fire("llm_input", {
        model: "gpt-4",
        provider: "openai",
        prompt: "Use a tool",
      }, { sessionKey: "sess-1" });

      fire("before_tool_call", {
        toolName: "search",
        params: { query: "test" },
        toolCallId: "tc-1",
      }, { sessionKey: "sess-1" });

      expect(state.startChildSpan).toHaveBeenCalledTimes(2); // llm + tool

      fire("after_tool_call", {
        toolName: "search",
        toolCallId: "tc-1",
        result: { data: "found" },
      }, { sessionKey: "sess-1" });

      expect(toolSpan.setAttribute).toHaveBeenCalledWith("output.value", expect.any(String));
      expect(toolSpan.end).toHaveBeenCalled();
    });

    it("handles tool error in after_tool_call", () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      const toolSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);
      state.startChildSpan.mockReturnValueOnce(toolSpan);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "test" }, { sessionKey: "sess-1" });
      fire("before_tool_call", { toolName: "search", toolCallId: "tc-1", params: {} }, { sessionKey: "sess-1" });
      fire("after_tool_call", { toolName: "search", toolCallId: "tc-1", error: "not found" }, { sessionKey: "sess-1" });

      expect(toolSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2 })
      );
      expect(toolSpan.end).toHaveBeenCalled();
    });

    it("handles after_tool_call with no matching before as no-op", () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "test" }, { sessionKey: "sess-1" });

      // after_tool_call with no before — should not throw
      fire("after_tool_call", {
        toolName: "unknown_tool",
        toolCallId: "tc-999",
        result: "data",
      }, { sessionKey: "sess-1" });
    });
  });

  describe("agent_end", () => {
    it("finalizes root span with metadata and ends all spans", async () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);

      fire("llm_input", {
        model: "gpt-4",
        provider: "openai",
        prompt: "Hello",
      }, {
        sessionKey: "sess-1",
        agentId: "agent-1",
        channelId: "ch-1",
        trigger: "slash",
      });

      fire("llm_output", {
        model: "gpt-4",
        provider: "openai",
        assistantTexts: ["Goodbye"],
        usage: { input: 5, output: 10, total: 15 },
      }, { sessionKey: "sess-1" });

      fire("agent_end", {
        success: true,
        messages: [],
      }, { sessionKey: "sess-1" });

      await flushMicrotasks();

      expect(rootSpan.setAttribute).toHaveBeenCalledWith("output.value", "Goodbye");
      expect(rootSpan.setAttribute).toHaveBeenCalledWith("output.mime_type", "text/plain");
      expect(rootSpan.end).toHaveBeenCalled();
    });

    it("ends orphaned tool and LLM spans", async () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      const toolSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);
      state.startChildSpan.mockReturnValueOnce(toolSpan);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "test" }, { sessionKey: "sess-1" });
      fire("before_tool_call", { toolName: "search", params: {}, toolCallId: "tc-1" }, { sessionKey: "sess-1" });

      // Don't fire after_tool_call or llm_output — leave spans orphaned

      fire("agent_end", { success: true, messages: [] }, { sessionKey: "sess-1" });

      await flushMicrotasks();

      expect(toolSpan.end).toHaveBeenCalled();
      expect(llmSpan.end).toHaveBeenCalled();
      expect(rootSpan.end).toHaveBeenCalled();
    });

    it("sets error status when event.error is present", async () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "test" }, { sessionKey: "sess-1" });
      fire("agent_end", { error: "something went wrong", messages: [] }, { sessionKey: "sess-1" });

      await flushMicrotasks();

      expect(rootSpan.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ code: 2, message: "something went wrong" })
      );
    });

    it("extracts output from messages when no prior llm_output", async () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan = mockSpan();
      const llmSpan = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan);
      state.startChildSpan.mockReturnValueOnce(llmSpan);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "test" }, { sessionKey: "sess-1" });
      fire("agent_end", {
        success: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "goodbye" },
        ],
      }, { sessionKey: "sess-1" });

      await flushMicrotasks();

      expect(rootSpan.setAttribute).toHaveBeenCalledWith("output.value", "goodbye");
    });
  });

  describe("llm_input with existing trace", () => {
    it("closes old trace before creating new one", () => {
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      const rootSpan1 = mockSpan();
      const llmSpan1 = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan1);
      state.startChildSpan.mockReturnValueOnce(llmSpan1);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "first" }, { sessionKey: "sess-1" });

      const rootSpan2 = mockSpan();
      const llmSpan2 = mockSpan();
      state.startRootSpan.mockReturnValueOnce(rootSpan2);
      state.startChildSpan.mockReturnValueOnce(llmSpan2);

      fire("llm_input", { model: "gpt-4", provider: "openai", prompt: "second" }, { sessionKey: "sess-1" });

      expect(rootSpan1.end).toHaveBeenCalled();
    });
  });

  describe("no-op when not ready", () => {
    it("skips llm_input when tracer is null", () => {
      state.getTracer.mockReturnValue(null);
      const { api, fire } = createMockApi();
      plugin.register(api as any);

      fire("llm_input", { model: "gpt-4", prompt: "test" }, { sessionKey: "sess-1" });

      expect(state.startRootSpan).not.toHaveBeenCalled();
    });
  });

  describe("service start/stop", () => {
    it("stop flushes and shuts down OTEL", async () => {
      const { api, getService } = createMockApi();
      plugin.register(api as any);

      const service = getService();
      expect(service).toBeDefined();

      await service.stop();
      expect(state.forceFlush).toHaveBeenCalled();
      expect(state.shutdown).toHaveBeenCalled();
    });
  });
});
