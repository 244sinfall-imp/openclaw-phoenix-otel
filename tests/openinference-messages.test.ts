import { describe, expect, it } from "vitest";
import { extractToolCallsFromMessages } from "../src/service/openinference-messages.js";

describe("extractToolCallsFromMessages", () => {
  it("matches tool results without ids in call order for the same tool name", () => {
    const calls = extractToolCallsFromMessages([
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "a.txt" } }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "b.txt" } }],
      },
      { role: "tool", name: "read", content: "content-a" },
      { role: "tool", name: "read", content: "content-b" },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: "read", arguments: { path: "a.txt" }, result: "content-a" });
    expect(calls[1]).toMatchObject({ name: "read", arguments: { path: "b.txt" }, result: "content-b" });
  });

  it("prefers id-based matching when toolCallId is present", () => {
    const calls = extractToolCallsFromMessages([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "exec", arguments: { command: "pwd" } },
          { type: "toolCall", id: "call-2", name: "exec", arguments: { command: "ls" } },
        ],
      },
      {
        role: "toolResult",
        content: [{ type: "toolResult", toolUseId: "call-2", content: "ls-result" }],
      },
      {
        role: "toolResult",
        content: [{ type: "toolResult", toolUseId: "call-1", content: "pwd-result" }],
      },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: "call-1", name: "exec", result: "pwd-result" });
    expect(calls[1]).toMatchObject({ id: "call-2", name: "exec", result: "ls-result" });
  });
});
