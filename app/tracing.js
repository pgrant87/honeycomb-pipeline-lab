'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { Resource } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} = require('@opentelemetry/semantic-conventions');

// Trace exporter
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

// Metrics exporter
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
// Views must come from the sdk-metrics copy NodeSDK loads. A second copy makes
// aggregation class checks fail and the exponential-histogram view is ignored.
const path = require('path');
const sdkNodeDir = path.dirname(require.resolve('@opentelemetry/sdk-node/package.json'));
const sdkMetrics = require(require.resolve('@opentelemetry/sdk-metrics', { paths: [sdkNodeDir] }));
const { View, InstrumentType, ExponentialHistogramAggregation } = sdkMetrics;

// Logs exporter
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const {
  LoggerProvider,
  BatchLogRecordProcessor,
} = require('@opentelemetry/sdk-logs');
const logsAPI = require('@opentelemetry/api-logs');
const api = require('@opentelemetry/api');
const { ExportResultCode } = require('@opentelemetry/core');
const telemetryControls = require('./telemetry-controls');

// Auto-instrumentations
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

const OTEL_COLLECTOR_URL =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318';

// ── Resource ────────────────────────────────────────────────────────────
const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'meme-generator',
  [ATTR_SERVICE_VERSION]: '1.0.0',
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.DEPLOY_ENV || 'dev',
});

// ── Traces ──────────────────────────────────────────────────────────────
const innerTraceExporter = new OTLPTraceExporter({
  url: `${OTEL_COLLECTOR_URL}/v1/traces`,
});
const traceExporter = {
  export(items, resultCallback) {
    if (!telemetryControls.isTracesEnabled()) {
      return resultCallback({ code: ExportResultCode.SUCCESS });
    }
    return innerTraceExporter.export(items, resultCallback);
  },
  shutdown: () => innerTraceExporter.shutdown(),
  forceFlush: () => innerTraceExporter.forceFlush(),
};

// ── Metrics ─────────────────────────────────────────────────────────────
const innerMetricExporter = new OTLPMetricExporter({
  url: `${OTEL_COLLECTOR_URL}/v1/metrics`,
});
const metricExporter = {
  export(metrics, resultCallback) {
    if (!telemetryControls.isMetricsEnabled()) {
      return resultCallback({ code: ExportResultCode.SUCCESS });
    }
    return innerMetricExporter.export(metrics, resultCallback);
  },
  shutdown: () => innerMetricExporter.shutdown(),
  forceFlush: () => innerMetricExporter.forceFlush(),
  selectAggregation: (instrumentType) => innerMetricExporter.selectAggregation(instrumentType),
  selectAggregationTemporality: (instrumentType) =>
    innerMetricExporter.selectAggregationTemporality(instrumentType),
};

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  // Cumulative temporality (OTLP default). Honeycomb applies INCREASE/RATE to
  // monotonic sums and LAST to gauges. 15s keeps a lab chart moving.
  exportIntervalMillis: 15_000,
});

// Latency histograms use exponential buckets so Honeycomb can store them as
// native histograms and merge percentiles across time and attributes.
// memes.caption.length keeps the default explicit buckets (bounded, known range).
const exponentialHistogramView = (instrumentName) => new View({
  instrumentName,
  instrumentType: InstrumentType.HISTOGRAM,
  aggregation: new ExponentialHistogramAggregation(),
});

// ── Logs ────────────────────────────────────────────────────────────────
const innerLogExporter = new OTLPLogExporter({
  url: `${OTEL_COLLECTOR_URL}/v1/logs`,
});
const logExporter = {
  export(logs, resultCallback) {
    if (!telemetryControls.isLogsEnabled()) {
      return resultCallback({ code: ExportResultCode.SUCCESS });
    }
    return innerLogExporter.export(logs, resultCallback);
  },
  shutdown: () => innerLogExporter.shutdown(),
  forceFlush: () => innerLogExporter.forceFlush(),
};

const loggerProvider = new LoggerProvider({ resource });
loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
logsAPI.logs.setGlobalLoggerProvider(loggerProvider);

// ── SDK init ────────────────────────────────────────────────────────────
const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader,
  views: [
    exponentialHistogramView('memes.generation.duration'),
    exponentialHistogramView('endpoint.duration'),
  ],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingPaths: ['/api/health'],
    }),
    new ExpressInstrumentation(),
  ],
});

sdk.start();
console.log('🔭 OpenTelemetry SDK initialised — traces, metrics & logs → collector');

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down OTel SDK…');
  await sdk.shutdown();
  await loggerProvider.shutdown();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/** Push pending spans, metrics, and log batches to the collector (e.g. right after boot). */
async function flushTelemetry() {
  const tracerProvider = api.trace.getTracerProvider();
  if (tracerProvider && typeof tracerProvider.forceFlush === 'function') {
    await tracerProvider.forceFlush();
  }
  const meterProvider = api.metrics.getMeterProvider();
  if (meterProvider && typeof meterProvider.forceFlush === 'function') {
    await meterProvider.forceFlush();
  }
  await loggerProvider.forceFlush();
}

module.exports = { flushTelemetry };
