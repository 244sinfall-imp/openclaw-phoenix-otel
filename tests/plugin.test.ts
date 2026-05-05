import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock openclaw/plugin-sdk
vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: vi.fn(() => ({})),
  onDiagnosticEvent: vi.fn(),
  SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
}));

// Mock otel-bridge
const mockRootSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
};
const mockLlmSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
};
const mockToolSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
};

// Track which child spans were created per root span to distinguish LLM vs tool spans
// Strategy: first startChildSpan call after each llm_input = LLM span; subsequent = tool spans
const childSpanCallsPerRoot = new Map<object, number>();

vi.mock("../src/service/otel-bridge.js", () => ({
  initOtel: vi.fn(),
  getTracer: vi.fn(() => ({})), // non-null = ready
  startRootSpan: vi.fn(() => {
    childSpanCallsPerRoot.set(mockRootSpan, 0);
    return mockRootSpan;
  }),
  startChildSpan: vi.fn((parent: any, name: string) => {
    const calls = (childSpanCallsPerRoot.get(mockRootSpan) ?? 0) + 1;
    childSpanCallsPerRoot.set(mockRootSpan, calls);
    // First child is always the LLM span; subsequent are tool spans
    return calls === 1 ? mockLlmSpan : mockToolSpan;
  }),
  forceFlush: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}),
  SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
  context: { active: vi.fn(() => ({})) },
  trace: { setSpan: vi.fn((ctx: any) => ctx) },
}));

// Helper: build a mock API that captures event handlers
function buildMockApi(pluginConfig: unknown = {}) {
  const handlers: Record<string, Function[]> = {};
  let serviceRegistration: { id: string; start: Function; stop: Function } | null = null;

  const api = {
    pluginConfig,
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    registerService: vi.fn((service: any) => {
      serviceRegistration = service;
    }),
    emit: (event: string, eventData: any, ctx: any) => {
      for (const h of handlers[event] ?? []) h(eventData, ctx);
    },
    getService: () => serviceRegistration,
  };
  return api;
}

function makeAgentCtx(overrides: Record<string, unknown> = {}) {
  return { sessionKey: "sess-abc", channelId: "signal", ...overrides };
}

// Flush microtasks (agent_end uses queueMicrotask)
function flushMicrotasks() {
  return new Promise((r) => setTimeout(r, 0));
}

describe("plugin registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childSpanCallsPerRoot.clear();
  });

  it("registers all expected event handlers", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);
    expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(api.registerService).toHaveBeenCalledWith(expect.objectContaining({ id: "phoenix-otel" }));
  });

  it("calls initOtel with config during register", async () => {
    const { default: plugin } = await import("../index.js");
    const { initOtel } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi({ endpoint: "https://custom.phoenix.io", apiKey: "sk-123", projectName: "myproj" });
    plugin.register(api as any);
    expect(initOtel).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: "https://custom.phoenix.io",
      apiKey: "sk-123",
      projectName: "myproj",
    }));
  });
});

describe("llm_input handler", () => {
  beforeEach(() => { vi.clearAllMocks(); childSpanCallsPerRoot.clear(); });

  it("creates root and LLM spans with correct attributes", async () => {
    const { default: plugin } = await import("../index.js");
    const { startRootSpan, startChildSpan } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi();
    plugin.register(api as any);

    api.emit("llm_input", {
      model: "claude-opus-4",
      provider: "anthropic",
      prompt: "Hello world",
      systemPrompt: "You are helpful.",
      historyMessages: [{ role: "user", content: "prior msg" }],
    }, makeAgentCtx());

    expect(startRootSpan).toHaveBeenCalledWith(
      expect.stringContaining("claude-opus-4"),
      expect.objectContaining({
        "openinference.span.kind": "AGENT",
        "llm.model_name": "claude-opus-4",
        "llm.provider": "anthropic",
        "session.id": "sess-abc",
      }),
    );
    expect(startChildSpan).toHaveBeenCalledWith(
      mockRootSpan,
      expect.any(String),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openinference.span.kind": "LLM",
          "llm.model_name": "claude-opus-4",
        }),
      }),
    );
    // Input messages should be set
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith(
      "llm.input_messages.0.message.role", "system",
    );
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith(
      "llm.input_messages.1.message.role", "user",
    );
  });

  it("sets user.id when senderId present", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    api.emit("llm_input", { model: "gpt-5", provider: "openai", prompt: "hi" },
      makeAgentCtx({ senderId: "+15551234567" }));

    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith("user.id", "+15551234567");
  });

  it("normalizes openai-codex provider", async () => {
    const { default: plugin } = await import("../index.js");
    const { startRootSpan } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi();
    plugin.register(api as any);

    api.emit("llm_input", { model: "codex-model", provider: "openai-codex", prompt: "hi" },
      makeAgentCtx());

    expect(startRootSpan).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ "llm.provider": "openai" }),
    );
  });

  it("exports tool-call messages using OpenInference tool_call attributes", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    api.emit("llm_input", {
      model: "m",
      prompt: "continue",
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "pwd" } }],
        },
        {
          role: "toolResult",
          content: [{ type: "toolResult", toolUseId: "call-1", content: "/repo" }],
        },
      ],
    }, makeAgentCtx());

    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.input_messages.0.message.role", "assistant");
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith(
      "llm.input_messages.0.message.tool_calls.0.tool_call.id", "call-1",
    );
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith(
      "llm.input_messages.0.message.tool_calls.0.tool_call.function.name", "exec",
    );
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith(
      "llm.input_messages.0.message.tool_calls.0.tool_call.function.arguments", '{"command":"pwd"}',
    );
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.input_messages.1.message.role", "tool");
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.input_messages.1.message.tool_call_id", "call-1");
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.input_messages.1.message.content", "/repo");
  });

  it("closes existing trace for session before starting new one", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    // First input
    api.emit("llm_input", { model: "m1", prompt: "first" }, ctx);
    // Second input on same session — should close first
    api.emit("llm_input", { model: "m2", prompt: "second" }, ctx);

    expect(mockRootSpan.end).toHaveBeenCalled();
  });
});

describe("llm_output handler", () => {
  beforeEach(() => { vi.clearAllMocks(); childSpanCallsPerRoot.clear(); });

  it("sets output attributes and ends LLM span", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "claude-opus-4", provider: "anthropic", prompt: "hi" }, ctx);
    api.emit("llm_output", {
      model: "claude-opus-4",
      provider: "anthropic",
      assistantTexts: ["Hello back!"],
      usage: { input: 100, output: 50, total: 150, cacheRead: 20, cacheWrite: 5 },
    }, ctx);

    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("output.value", "Hello back!");
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.prompt", 100);
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.completion", 50);
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.total", 150);
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.prompt_details.cache_read", 20);
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.token_count.prompt_details.cache_write", 5);
    expect(mockLlmSpan.end).toHaveBeenCalled();
  });

  it("sets output messages on LLM span", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("llm_output", { assistantTexts: ["Part 1", "Part 2"] }, ctx);

    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.output_messages.0.message.role", "assistant");
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.output_messages.0.message.content", "Part 1");
    expect(mockLlmSpan.setAttribute).toHaveBeenCalledWith("llm.output_messages.1.message.role", "assistant");
  });

  it("is a no-op for unknown session", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    // No llm_input before output
    api.emit("llm_output", { assistantTexts: ["text"] }, makeAgentCtx({ sessionKey: "unknown" }));
    expect(mockLlmSpan.end).not.toHaveBeenCalled();
  });
});

describe("tool call handlers", () => {
  beforeEach(() => { vi.clearAllMocks(); childSpanCallsPerRoot.clear(); });

  it("before_tool_call creates a TOOL span", async () => {
    const { default: plugin } = await import("../index.js");
    const { startChildSpan } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("before_tool_call", { toolName: "exec", params: { cmd: "ls" }, toolCallId: "tc1" }, ctx);

    expect(startChildSpan).toHaveBeenCalledWith(
      mockRootSpan,
      "exec",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openinference.span.kind": "TOOL",
          "tool.name": "exec",
        }),
      }),
    );
  });

  it("after_tool_call sets output and ends span on success", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("before_tool_call", { toolName: "exec", params: {}, toolCallId: "tc1" }, ctx);
    api.emit("after_tool_call", { toolName: "exec", toolCallId: "tc1", result: { output: "ok" } }, ctx);

    expect(mockToolSpan.setAttribute).toHaveBeenCalledWith("output.value", expect.any(String));
    expect(mockToolSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // OK
    expect(mockToolSpan.end).toHaveBeenCalled();
  });

  it("after_tool_call sets error status on error", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("before_tool_call", { toolName: "exec", params: {}, toolCallId: "tc2" }, ctx);
    api.emit("after_tool_call", { toolName: "exec", toolCallId: "tc2", error: "command failed" }, ctx);

    expect(mockToolSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "command failed" }); // ERROR
    expect(mockToolSpan.end).toHaveBeenCalled();
  });

  it("after_tool_call is a no-op when no matching before_tool_call", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    // No before_tool_call for tc-unknown
    api.emit("after_tool_call", { toolName: "exec", toolCallId: "tc-unknown", result: "ok" }, ctx);

    expect(mockToolSpan.end).not.toHaveBeenCalled();
  });

  it("matches tool span by name fallback when no toolCallId", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("before_tool_call", { toolName: "read", params: {} }, ctx); // no toolCallId
    api.emit("after_tool_call", { toolName: "read", result: "content" }, ctx); // no toolCallId

    expect(mockToolSpan.end).toHaveBeenCalled();
  });
});

describe("agent_end handler", () => {
  beforeEach(() => { vi.clearAllMocks(); childSpanCallsPerRoot.clear(); });

  it("ends root span after microtask flush", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("llm_output", { assistantTexts: ["done"] }, ctx);
    api.emit("agent_end", {}, ctx);

    // Root span not ended yet (deferred via queueMicrotask)
    await flushMicrotasks();

    expect(mockRootSpan.end).toHaveBeenCalled();
  });

  it("sets OK status on successful end", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("agent_end", {}, ctx);
    await flushMicrotasks();

    expect(mockRootSpan.setStatus).toHaveBeenCalledWith({ code: 1 }); // OK
  });

  it("sets ERROR status when agent_end has error", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("agent_end", { error: "timeout" }, ctx);
    await flushMicrotasks();

    expect(mockRootSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "timeout" }); // ERROR
  });

  it("ends orphaned tool spans", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("before_tool_call", { toolName: "exec", params: {}, toolCallId: "tc-orphan" }, ctx);
    // No after_tool_call — orphaned
    api.emit("agent_end", {}, ctx);
    await flushMicrotasks();

    expect(mockToolSpan.end).toHaveBeenCalled();
  });

  it("sets metadata attribute with channel and sessionKey", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx({ channelId: "signal", sessionKey: "sess-xyz" });
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("agent_end", {}, ctx);
    await flushMicrotasks();

    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith(
      "metadata",
      expect.stringContaining("signal"),
    );
    expect(mockRootSpan.setAttribute).toHaveBeenCalledWith(
      "metadata",
      expect.stringContaining("sess-xyz"),
    );
  });

  it("cleans up trace from activeTraces map", async () => {
    const { default: plugin } = await import("../index.js");
    const { startRootSpan } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    const callsBefore = (startRootSpan as any).mock.calls.length;

    api.emit("agent_end", {}, ctx);
    await flushMicrotasks();

    // A new llm_input should not try to close a non-existent trace
    api.emit("llm_input", { model: "m2", prompt: "hi again" }, ctx);
    expect(mockRootSpan.end).toHaveBeenCalledTimes(1); // only once from agent_end
  });

  it("creates post-hoc TOOL spans from message snapshots when hook spans were missing", async () => {
    const { default: plugin } = await import("../index.js");
    const { startChildSpan } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const ctx = makeAgentCtx();
    api.emit("llm_input", { model: "m", prompt: "hi" }, ctx);
    api.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
        },
        {
          role: "toolResult",
          content: [{ type: "toolResult", toolUseId: "call-1", content: "# README" }],
        },
      ],
    }, ctx);
    await flushMicrotasks();

    expect(startChildSpan).toHaveBeenCalledWith(
      mockRootSpan,
      "read",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openinference.span.kind": "TOOL",
          "tool.name": "read",
          "tool.id": "call-1",
          "tool_call.function.arguments": '{"path":"README.md"}',
        }),
      }),
    );
    expect(mockToolSpan.setAttribute).toHaveBeenCalledWith("output.value", "# README");
    expect(mockToolSpan.end).toHaveBeenCalled();
  });

  it("is a no-op for unknown session", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    api.emit("agent_end", {}, makeAgentCtx({ sessionKey: "no-such-session" }));
    await flushMicrotasks();

    expect(mockRootSpan.end).not.toHaveBeenCalled();
  });
});

describe("service lifecycle", () => {
  beforeEach(() => { vi.clearAllMocks(); childSpanCallsPerRoot.clear(); });

  it("start logs project and endpoint", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi({ projectName: "bloom_chat" });
    plugin.register(api as any);

    const service = api.getService()!;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await service.start({ logger });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("bloom_chat"));
  });

  it("stop flushes and shuts down OTEL", async () => {
    const { default: plugin } = await import("../index.js");
    const { forceFlush, shutdown } = await import("../src/service/otel-bridge.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const service = api.getService()!;
    await service.start({ logger: { info: vi.fn(), warn: vi.fn() } });
    await service.stop();

    expect(forceFlush).toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalled();
  });

  it("stop ends all active traces", async () => {
    const { default: plugin } = await import("../index.js");
    const api = buildMockApi();
    plugin.register(api as any);

    const service = api.getService()!;
    await service.start({ logger: { info: vi.fn(), warn: vi.fn() } });

    // Start a trace but don't end it
    api.emit("llm_input", { model: "m", prompt: "hi" }, makeAgentCtx());
    await service.stop();

    expect(mockRootSpan.end).toHaveBeenCalled();
  });
});
