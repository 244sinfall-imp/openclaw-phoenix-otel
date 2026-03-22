import { trace, context, SpanStatusCode, type Span, type Tracer, type SpanOptions } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export type OtelBridgeConfig = {
  endpoint: string;
  apiKey?: string;
  projectName: string;
  serviceName: string;
};

let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;

export function initOtel(config: OtelBridgeConfig): Tracer {
  const tracesEndpoint = config.endpoint.replace(/\/+$/, "") + "/v1/traces";

  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const exporter = new OTLPTraceExporter({
    url: tracesEndpoint,
    headers,
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    "openinference.project.name": config.projectName,
  });

  provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  // Do NOT call provider.register() — it would conflict with diagnostics-otel.
  // Get the tracer directly from our provider instance instead.
  tracer = provider.getTracer("openclaw-phoenix-otel", "1.0.0");
  return tracer;
}

export function getTracer(): Tracer | null {
  return tracer;
}

export function startRootSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
  if (!tracer) throw new Error("OTEL not initialized");
  return tracer.startSpan(name, { attributes });
}

export function startChildSpan(
  parent: Span,
  name: string,
  options?: SpanOptions,
): Span {
  if (!tracer) throw new Error("OTEL not initialized");
  const parentContext = trace.setSpan(context.active(), parent);
  return tracer.startSpan(name, options, parentContext);
}

export async function forceFlush(): Promise<void> {
  if (provider) {
    await provider.forceFlush();
  }
}

export async function shutdown(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
    tracer = null;
  }
}

export { SpanStatusCode, context, trace };
export type { Span };
