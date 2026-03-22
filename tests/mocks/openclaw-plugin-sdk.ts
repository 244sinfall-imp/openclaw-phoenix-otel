import { vi } from "vitest";

export function emptyPluginConfigSchema() {
  return {};
}

export function onDiagnosticEvent(_callback: (evt: any) => void) {}

export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

export type OpenClawPluginApi = {
  pluginConfig: unknown;
  on: (event: string, handler: (...args: any[]) => void) => void;
  registerService: (service: {
    id: string;
    start: (ctx: any) => Promise<void>;
    stop: () => Promise<void>;
  }) => void;
};
