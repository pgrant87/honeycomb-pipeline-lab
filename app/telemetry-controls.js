'use strict';

/** Runtime toggles: when false, OTLP export for that signal is skipped (nothing sent to collector/Honeycomb). */
const telemetryToggles = {
  traces: true,
  metrics: true,
  logs: true,
};

function getToggles() {
  return { ...telemetryToggles };
}

function setToggles(partial) {
  if (typeof partial.traces === 'boolean') telemetryToggles.traces = partial.traces;
  if (typeof partial.metrics === 'boolean') telemetryToggles.metrics = partial.metrics;
  if (typeof partial.logs === 'boolean') telemetryToggles.logs = partial.logs;
  return getToggles();
}

function isTracesEnabled() {
  return telemetryToggles.traces;
}

function isMetricsEnabled() {
  return telemetryToggles.metrics;
}

function isLogsEnabled() {
  return telemetryToggles.logs;
}

module.exports = {
  getToggles,
  setToggles,
  isTracesEnabled,
  isMetricsEnabled,
  isLogsEnabled,
};
