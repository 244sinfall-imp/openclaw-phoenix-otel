declare module "openclaw/plugin-sdk" {
  export type OpenClawPluginApi = {
    pluginConfig: unknown;
    on: (event: string, handler: (...args: any[]) => void) => void;
    registerService: (service: {
      id: string;
      start: (ctx: any) => Promise<void>;
      stop: () => Promise<void>;
    }) => void;
  };

  export function emptyPluginConfigSchema(): Record<string, unknown>;
  export function onDiagnosticEvent(callback: (evt: any) => void): void;
}
