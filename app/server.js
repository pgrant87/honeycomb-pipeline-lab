'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const telemetryControls = require('./telemetry-controls');
const { flushTelemetry } = require('./tracing');

// Refinery config path — Docker: ./refinery → /app/refinery; local: ../refinery
const REFINERY_DIR = fs.existsSync(path.join(__dirname, 'refinery'))
  ? path.join(__dirname, 'refinery')
  : path.join(__dirname, '..', 'refinery');
const REFINERY_RULES_PATH = path.join(REFINERY_DIR, 'rules.yaml');
const REFINERY_STATE_PATH = path.join(REFINERY_DIR, 'state.json');

const KEEP_ALL_RULES = `RulesVersion: 2
Samplers:
  __default__:
    DeterministicSampler:
      SampleRate: 1
`;

/** Default editor / “custom rules on” sampling: 1 in 10 traces (SampleRate: 10). */
const DEFAULT_CUSTOM_SAMPLING_RULES = `RulesVersion: 2
Samplers:
  __default__:
    DeterministicSampler:
      SampleRate: 10
`;

// ── OTel API imports ────────────────────────────────────────────────────
const { trace, SpanStatusCode, metrics } = require('@opentelemetry/api');
const logsAPI = require('@opentelemetry/api-logs');
const { SeverityNumber } = require('@opentelemetry/api-logs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Tracer & Meter & Logger ─────────────────────────────────────────────
const tracer = trace.getTracer('meme-generator', '1.0.0');
const meter = metrics.getMeter('meme-generator', '1.0.0');
const logger = logsAPI.logs.getLogger('meme-generator', '1.0.0');

// ── Metrics instruments ─────────────────────────────────────────────────
const memeCounter = meter.createCounter('memes.generated', {
  description: 'Total number of memes generated',
  unit: '{meme}',
});

const memeLatencyHistogram = meter.createHistogram('memes.generation.duration', {
  description: 'Time to generate a meme in milliseconds',
  unit: 'ms',
});

const activeUsers = meter.createUpDownCounter('users.active', {
  description: 'Currently active users (simulated)',
  unit: '{user}',
});

const buttonClickCounter = meter.createCounter('ui.button.clicks', {
  description: 'Button clicks by type',
  unit: '{click}',
});

const appStartupCounter = meter.createCounter('app.startup', {
  description: 'Application completed HTTP listen (boot waterline)',
  unit: '{event}',
});

const errorCounter = meter.createCounter('errors.total', {
  description: 'Total errors by type',
  unit: '{error}',
});

// ── Meme data ───────────────────────────────────────────────────────────
const MEME_TEMPLATES = [
  { id: 'drake',           name: 'Drake Hotline Bling',    emoji: '🕺' },
  { id: 'distracted',      name: 'Distracted Boyfriend',   emoji: '👀' },
  { id: 'expanding-brain', name: 'Expanding Brain',        emoji: '🧠' },
  { id: 'this-is-fine',    name: 'This Is Fine',           emoji: '🔥' },
  { id: 'one-does-not',    name: 'One Does Not Simply',    emoji: '🧙' },
  { id: 'change-my-mind',  name: 'Change My Mind',         emoji: '☕' },
  { id: 'always-has-been', name: 'Always Has Been',        emoji: '🔫' },
  { id: 'stonks',          name: 'Stonks',                 emoji: '📈' },
];

const TOP_TEXTS = [
  'When the deploy succeeds on Friday at 5pm',
  'Me explaining observability to my manager',
  'When you add one more dashboard',
  'Nobody:\nAbsolutely nobody:\nMy on-call pager:',
  'When the traces finally show up',
  'POV: You just enabled auto-instrumentation',
  'When someone says "just check the logs"',
  'That feeling when SLO budget is full',
];

const BOTTOM_TEXTS = [
  'And then it all catches fire',
  'It was DNS the whole time',
  'Narrator: It was not fine',
  '*Laughs in 99.99% uptime*',
  'We should have added tracing earlier',
  'The collector was down the whole time',
  'At least we have metrics now',
  'Time to add more spans',
];

// ── Helpers ─────────────────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function simulateWork(minMs, maxMs) {
  const duration = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function emitLog(severityNumber, severityText, body, attributes = {}) {
  logger.emit({
    severityNumber,
    severityText,
    body,
    attributes,
  });
}

// ── Routes ──────────────────────────────────────────────────────────────

// GET /api/telemetry/toggles — traces / metrics / logs export switches
app.get('/api/telemetry/toggles', (_req, res) => {
  res.json(telemetryControls.getToggles());
});

// PUT /api/telemetry/toggles — body: { traces?, metrics?, logs? }
app.put('/api/telemetry/toggles', (req, res) => {
  const updated = telemetryControls.setToggles(req.body || {});
  emitLog(SeverityNumber.INFO, 'INFO', 'Telemetry export toggles updated', {
    'telemetry.traces': updated.traces,
    'telemetry.metrics': updated.metrics,
    'telemetry.logs': updated.logs,
  });
  res.json(updated);
});

// GET /api/templates — list available meme templates
app.get('/api/templates', (_req, res) => {
  const span = trace.getActiveSpan();
  span?.setAttribute('templates.count', MEME_TEMPLATES.length);

  emitLog(SeverityNumber.INFO, 'INFO', 'Templates list requested', {
    'templates.count': MEME_TEMPLATES.length,
  });

  res.json({ templates: MEME_TEMPLATES });
});

// POST /api/generate — generate a meme (the star of the show)
app.post('/api/generate', async (req, res) => {
  const start = performance.now();
  const { templateId, mode } = req.body; // mode: 'random' | 'chaos' | 'wholesome'

  return tracer.startActiveSpan('generate-meme', async (parentSpan) => {
    const memeId = crypto.randomUUID();
    parentSpan.setAttribute('meme.id', memeId);
    parentSpan.setAttribute('meme.template', templateId || 'random');
    parentSpan.setAttribute('meme.mode', mode || 'random');

    emitLog(SeverityNumber.INFO, 'INFO', `Meme generation started`, {
      'meme.id': memeId,
      'meme.template': templateId || 'random',
      'meme.mode': mode || 'random',
    });

    try {
      // ── Child span: select template ────────────────────────────────
      const template = await tracer.startActiveSpan('select-template', async (span) => {
        await simulateWork(10, 50);
        const t = templateId
          ? MEME_TEMPLATES.find((m) => m.id === templateId) || pick(MEME_TEMPLATES)
          : pick(MEME_TEMPLATES);
        span.setAttribute('template.id', t.id);
        span.setAttribute('template.name', t.name);
        span.end();
        return t;
      });

      // ── Child span: generate captions ──────────────────────────────
      const captions = await tracer.startActiveSpan('generate-captions', async (span) => {
        await simulateWork(30, 120);
        const topText = pick(TOP_TEXTS);
        const bottomText = pick(BOTTOM_TEXTS);
        span.setAttribute('caption.top.length', topText.length);
        span.setAttribute('caption.bottom.length', bottomText.length);

        emitLog(SeverityNumber.DEBUG, 'DEBUG', 'Captions generated', {
          'meme.id': memeId,
          'caption.top': topText,
          'caption.bottom': bottomText,
        });

        span.end();
        return { topText, bottomText };
      });

      // ── Child span: render meme ────────────────────────────────────
      const renderedMeme = await tracer.startActiveSpan('render-meme', async (span) => {
        await simulateWork(50, 200);

        // Simulate occasional slow renders
        if (Math.random() < 0.1) {
          span.addEvent('slow-render-detected', { 'delay.ms': 500 });
          emitLog(SeverityNumber.WARN, 'WARN', 'Slow meme render detected', {
            'meme.id': memeId,
            'render.slow': true,
          });
          await simulateWork(400, 600);
        }

        const result = {
          id: memeId,
          template: template,
          topText: captions.topText,
          bottomText: captions.bottomText,
          generatedAt: new Date().toISOString(),
        };

        span.setAttribute('render.success', true);
        span.end();
        return result;
      });

      // ── Child span: quality check (sometimes fails!) ───────────────
      await tracer.startActiveSpan('quality-check', async (span) => {
        await simulateWork(10, 40);

        // 5% chance of "low quality" warning
        if (Math.random() < 0.05) {
          span.addEvent('quality-warning', { reason: 'font-overlap-detected' });
          emitLog(SeverityNumber.WARN, 'WARN', 'Meme quality check: font overlap', {
            'meme.id': memeId,
            'quality.issue': 'font-overlap-detected',
          });
        }

        span.setAttribute('quality.passed', true);
        span.end();
      });

      // ── Record metrics ─────────────────────────────────────────────
      const durationMs = performance.now() - start;
      memeCounter.add(1, {
        'template.id': template.id,
        'meme.mode': mode || 'random',
      });
      memeLatencyHistogram.record(durationMs, {
        'template.id': template.id,
      });
      buttonClickCounter.add(1, { 'button.type': 'generate' });

      parentSpan.setAttribute('meme.duration_ms', durationMs);
      parentSpan.setStatus({ code: SpanStatusCode.OK });

      emitLog(SeverityNumber.INFO, 'INFO', `Meme generated successfully`, {
        'meme.id': memeId,
        'meme.template': template.id,
        'meme.duration_ms': Math.round(durationMs),
      });

      parentSpan.end();
      return res.json({ meme: renderedMeme, durationMs: Math.round(durationMs) });

    } catch (err) {
      parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      parentSpan.recordException(err);
      errorCounter.add(1, { 'error.type': 'generation_failed' });

      emitLog(SeverityNumber.ERROR, 'ERROR', `Meme generation failed: ${err.message}`, {
        'meme.id': memeId,
        'error.type': err.name,
        'error.message': err.message,
      });

      parentSpan.end();
      return res.status(500).json({ error: 'Meme generation failed' });
    }
  });
});

// POST /api/rate — rate a meme (records metrics + traces)
app.post('/api/rate', async (req, res) => {
  const { memeId, rating } = req.body;

  return tracer.startActiveSpan('rate-meme', async (span) => {
    span.setAttribute('meme.id', memeId);
    span.setAttribute('meme.rating', rating);

    buttonClickCounter.add(1, { 'button.type': `rate_${rating}` });

    emitLog(SeverityNumber.INFO, 'INFO', `Meme rated: ${rating}`, {
      'meme.id': memeId,
      'meme.rating': rating,
    });

    await simulateWork(5, 20);
    span.end();
    res.json({ success: true, memeId, rating });
  });
});

// POST /api/chaos — trigger a controlled error for demo purposes
app.post('/api/chaos', async (_req, res) => {
  return tracer.startActiveSpan('chaos-endpoint', async (span) => {
    span.setAttribute('chaos.enabled', true);

    const roll = Math.random();

    if (roll < 0.33) {
      // Simulate timeout
      span.addEvent('simulated-timeout');
      emitLog(SeverityNumber.ERROR, 'ERROR', 'Chaos: simulated timeout', {
        'chaos.type': 'timeout',
      });
      errorCounter.add(1, { 'error.type': 'timeout' });
      await simulateWork(2000, 3000);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Simulated timeout' });
      span.end();
      return res.status(504).json({ error: 'Simulated timeout', chaosType: 'timeout' });

    } else if (roll < 0.66) {
      // Simulate 500 error
      const err = new Error('Simulated internal error');
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      emitLog(SeverityNumber.ERROR, 'ERROR', 'Chaos: simulated 500 error', {
        'chaos.type': 'internal_error',
      });
      errorCounter.add(1, { 'error.type': 'internal_error' });
      span.end();
      return res.status(500).json({ error: 'Simulated 500', chaosType: 'internal_error' });

    } else {
      // Simulate success but with a warning
      span.addEvent('chaos-near-miss', { 'roll': roll });
      emitLog(SeverityNumber.WARN, 'WARN', 'Chaos: near miss — request survived', {
        'chaos.type': 'near_miss',
        'chaos.roll': roll,
      });
      buttonClickCounter.add(1, { 'button.type': 'chaos_survived' });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return res.json({ success: true, chaosType: 'near_miss', message: 'You survived chaos!' });
    }
  });
});

// ── Health check (collector + refinery) ──────────────────────────────────

async function checkHealth(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

app.get('/api/health', async (_req, res) => {
  const [collector, refinery] = await Promise.all([
    checkHealth('http://otel-collector:13133/'),
    checkHealth('http://refinery:8080/ready'),
  ]);
  // Web app (this Node process) is up if we’re answering — useful for UI parity with other containers
  res.json({ app: true, collector, refinery });
});

// ── Refinery API (toggle + rules) ───────────────────────────────────────

function readRefineryState() {
  const fresh = { enabled: false, customRules: DEFAULT_CUSTOM_SAMPLING_RULES };
  try {
    const data = fs.readFileSync(REFINERY_STATE_PATH, 'utf8');
    const state = JSON.parse(data);
    if (typeof state.customRules !== 'string' || state.customRules.trim() === '') {
      state.customRules = DEFAULT_CUSTOM_SAMPLING_RULES;
    }
    if (typeof state.enabled !== 'boolean') {
      state.enabled = false;
    }
    return state;
  } catch {
    return fresh;
  }
}

function writeRefineryState(state) {
  fs.mkdirSync(REFINERY_DIR, { recursive: true });
  fs.writeFileSync(REFINERY_STATE_PATH, JSON.stringify(state, null, 2));
}

function writeRefineryRules(yaml) {
  fs.mkdirSync(REFINERY_DIR, { recursive: true });
  fs.writeFileSync(REFINERY_RULES_PATH, yaml);
}

// GET /api/refinery — status + rules
app.get('/api/refinery', (_req, res) => {
  const state = readRefineryState();
  let rules;
  if (state.enabled) {
    try {
      rules = fs.readFileSync(REFINERY_RULES_PATH, 'utf8');
    } catch {
      rules = state.customRules;
    }
  } else {
    // Pass-through lives in rules.yaml on disk; editor shows the template that will apply when enabled
    rules = state.customRules;
  }
  res.json({ enabled: state.enabled, rules });
});

// POST /api/refinery — toggle enabled
app.post('/api/refinery', (req, res) => {
  const state = readRefineryState();
  const enabled = req.body?.enabled ?? !state.enabled;
  const rulesFromBody = req.body?.rules;
  if (enabled && typeof rulesFromBody === 'string' && rulesFromBody.trim() !== '') {
    state.customRules = rulesFromBody;
  }
  state.enabled = enabled;
  writeRefineryState(state);
  writeRefineryRules(enabled ? state.customRules : KEEP_ALL_RULES);
  emitLog(SeverityNumber.INFO, 'INFO', `Refinery ${enabled ? 'enabled' : 'disabled'} (${enabled ? 'custom rules' : 'keep-all'})`);
  res.json({ enabled });
});

// PUT /api/refinery/rules — update rules (only applied when enabled)
app.put('/api/refinery/rules', (req, res) => {
  const { rules } = req.body;
  if (typeof rules !== 'string') {
    return res.status(400).json({ error: 'rules must be a string' });
  }
  const state = readRefineryState();
  state.customRules = rules;
  writeRefineryState(state);
  if (state.enabled) {
    writeRefineryRules(rules);
  }
  res.json({ success: true });
});

// POST /api/heartbeat — simple liveness with a log + metric
app.post('/api/heartbeat', (_req, res) => {
  activeUsers.add(1, { 'source': 'heartbeat' });

  emitLog(SeverityNumber.DEBUG, 'DEBUG', 'Heartbeat received');

  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// ── Start server ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎨 Meme Generator running on http://localhost:${PORT}`);
  tracer.startActiveSpan('server.startup', (span) => {
    span.setAttribute('server.port', PORT);
    emitLog(SeverityNumber.INFO, 'INFO', `Server started on port ${PORT}`, {
      'server.port': String(PORT),
    });
    appStartupCounter.add(1, { 'boot.phase': 'listen' });
  });
  flushTelemetry().catch((err) => console.error('OpenTelemetry flush after startup failed:', err));
});
