import type { Span } from "@opentelemetry/api";
import { safeStringify } from "./helpers.js";
import { sanitizeString, sanitizeValue } from "./payload-sanitizer.js";

export type ExtractedToolCall = {
  id?: string;
  name: string;
  arguments?: unknown;
  result?: unknown;
  error?: string;
};

type MessageRecord = Record<string, unknown>;

function asRecord(value: unknown): MessageRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MessageRecord)
    : undefined;
}

function stringFrom(record: MessageRecord | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function contentParts(message: MessageRecord): MessageRecord[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => asRecord(part) ? [asRecord(part)!] : []);
}

function isToolCallPart(part: MessageRecord): boolean {
  const type = stringFrom(part, ["type"]);
  return type === "toolCall" || type === "tool_use" || type === "function_call";
}

function isToolResultPart(part: MessageRecord): boolean {
  const type = stringFrom(part, ["type"]);
  return type === "toolResult" || type === "tool_result" || type === "tool_call_output";
}

function extractPartText(part: MessageRecord): string | undefined {
  const type = stringFrom(part, ["type"]);
  if (type === "text" || type === "output_text" || type === "input_text") {
    return stringFrom(part, ["text", "content"]);
  }
  if (isToolResultPart(part)) {
    const text = stringFrom(part, ["content", "text", "output"]);
    if (text) return text;
    const result = part.result ?? part.data;
    return result === undefined ? undefined : safeStringify(sanitizeValue(result));
  }
  return undefined;
}

function extractMessageText(message: MessageRecord): string | undefined {
  const direct = stringFrom(message, ["content", "text"]);
  if (direct) return sanitizeString(direct);

  const text = contentParts(message)
    .map((part) => extractPartText(part))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n")
    .trim();
  return text ? sanitizeString(text) : undefined;
}

function normalizeRole(message: MessageRecord): string {
  const rawRole = stringFrom(message, ["role"]);
  const parts = contentParts(message);
  const hasToolCall = parts.some(isToolCallPart);
  const hasToolResult = parts.some(isToolResultPart);

  if (rawRole === "tool" || rawRole === "function" || rawRole === "toolResult" || rawRole === "tool_result") {
    return "tool";
  }
  if (hasToolResult) return "tool";
  if (hasToolCall) return "assistant";
  if (rawRole === "system" || rawRole === "user" || rawRole === "assistant") return rawRole;
  if (rawRole === "custom") return "assistant";
  return rawRole ?? "user";
}

function extractToolCallsFromMessage(message: MessageRecord): ExtractedToolCall[] {
  const calls: ExtractedToolCall[] = [];

  for (const part of contentParts(message)) {
    if (!isToolCallPart(part)) continue;
    const name = stringFrom(part, ["name", "toolName", "functionName"]);
    if (!name) continue;
    calls.push({
      id: stringFrom(part, ["id", "toolCallId", "toolUseId", "call_id", "callId"]),
      name,
      arguments: part.arguments ?? part.input ?? part.args ?? part.params,
    });
  }

  const directToolCalls = message.toolCalls ?? message.tool_calls;
  if (Array.isArray(directToolCalls)) {
    for (const raw of directToolCalls) {
      const call = asRecord(raw);
      if (!call) continue;
      const fn = asRecord(call.function) ?? call;
      const name = stringFrom(fn, ["name", "functionName"]) ?? stringFrom(call, ["name", "toolName"]);
      if (!name) continue;
      calls.push({
        id: stringFrom(call, ["id", "toolCallId", "toolUseId", "call_id", "callId"]),
        name,
        arguments: fn.arguments ?? call.arguments ?? call.input ?? call.args ?? call.params,
      });
    }
  }

  return calls;
}

function extractToolResultFromMessage(message: MessageRecord): { id?: string; name?: string; result?: unknown; error?: string } | undefined {
  const parts = contentParts(message);
  const resultPart = parts.find(isToolResultPart);
  const source = resultPart ?? message;
  const role = stringFrom(message, ["role"]);
  if (!resultPart && role !== "tool" && role !== "toolResult" && role !== "tool_result" && role !== "function") {
    return undefined;
  }

  const resultText = extractMessageText(message);
  const result = resultText ?? source.result ?? source.output ?? source.content;
  return {
    id: stringFrom(source, ["toolCallId", "toolUseId", "tool_call_id", "call_id", "id"]),
    name: stringFrom(source, ["name", "toolName"]),
    result: sanitizeValue(result),
    error: stringFrom(source, ["error"]),
  };
}

export function setOpenInferenceMessageAttributes(
  span: Span,
  prefix: string,
  index: number,
  rawMessage: unknown,
): void {
  const message = typeof rawMessage === "string"
    ? { role: "user", content: rawMessage }
    : asRecord(rawMessage);
  if (!message) return;

  const messagePrefix = `${prefix}.${index}.message`;
  const role = normalizeRole(message);
  span.setAttribute(`${messagePrefix}.role`, role);

  const content = extractMessageText(message);
  if (content) {
    span.setAttribute(`${messagePrefix}.content`, content);
  }

  const toolResult = extractToolResultFromMessage(message);
  if (toolResult) {
    if (toolResult.id) span.setAttribute(`${messagePrefix}.tool_call_id`, toolResult.id);
    if (toolResult.name) span.setAttribute(`${messagePrefix}.name`, toolResult.name);
  }

  const toolCalls = extractToolCallsFromMessage(message);
  for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
    const call = toolCalls[toolIndex]!;
    const callPrefix = `${messagePrefix}.tool_calls.${toolIndex}.tool_call`;
    if (call.id) span.setAttribute(`${callPrefix}.id`, call.id);
    span.setAttribute(`${callPrefix}.function.name`, call.name);
    if (call.arguments !== undefined) {
      span.setAttribute(`${callPrefix}.function.arguments`, safeStringify(sanitizeValue(call.arguments)));
    }
  }
}

export function extractToolCallsFromMessages(messages: unknown): ExtractedToolCall[] {
  if (!Array.isArray(messages)) return [];

  const resultsById = new Map<string, { id?: string; name?: string; result?: unknown; error?: string }>();
  const looseResultsByName = new Map<string, Array<{ id?: string; name?: string; result?: unknown; error?: string }>>();
  const looseResultsAny: Array<{ id?: string; name?: string; result?: unknown; error?: string }> = [];

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const result = extractToolResultFromMessage(message);
    if (!result) continue;
    if (result.id) resultsById.set(result.id, result);
    else {
      looseResultsAny.push(result);
      if (result.name) {
        const queue = looseResultsByName.get(result.name) ?? [];
        queue.push(result);
        looseResultsByName.set(result.name, queue);
      }
    }
  }

  const calls: ExtractedToolCall[] = [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    for (const call of extractToolCallsFromMessage(message)) {
      let result = call.id ? resultsById.get(call.id) : undefined;

      if (!result) {
        const byNameQueue = looseResultsByName.get(call.name);
        if (byNameQueue && byNameQueue.length > 0) {
          result = byNameQueue.shift();
          if (byNameQueue.length === 0) looseResultsByName.delete(call.name);
          if (result) {
            const idx = looseResultsAny.indexOf(result);
            if (idx >= 0) looseResultsAny.splice(idx, 1);
          }
        }
      }

      if (!result && looseResultsAny.length > 0) {
        result = looseResultsAny.shift();
      }

      calls.push({
        ...call,
        ...(result?.result !== undefined ? { result: result.result } : {}),
        ...(result?.error ? { error: result.error } : {}),
      });
    }
  }
  return calls;
}
