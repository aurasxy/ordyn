/**
 * SOLUS IMAP Diagnostics — Metrics & Profiling Utilities
 *
 * Provides timing, histograms, memory sampling, and structured output
 * for performance analysis of IMAP sync operations.
 */

class MetricsCollector {
  constructor() {
    this.timers = {};       // named timers: { name: { start, end, elapsed } }
    this.counters = {};     // simple counters
    this.histograms = {};   // arrays of values for distribution analysis
    this.memory = [];       // periodic memory snapshots
    this.phases = [];       // ordered phase list with timings
    this._activePhase = null;
    this._runStart = Date.now();
  }

  // ── Timers ─────────────────────────────────────────────

  startTimer(name) {
    this.timers[name] = { start: Date.now(), end: null, elapsed: null };
  }

  stopTimer(name) {
    if (!this.timers[name]) return 0;
    this.timers[name].end = Date.now();
    this.timers[name].elapsed = this.timers[name].end - this.timers[name].start;
    return this.timers[name].elapsed;
  }

  getTimer(name) {
    return this.timers[name]?.elapsed || 0;
  }

  /**
   * Time an async function and return its result.
   */
  async timeAsync(name, fn) {
    this.startTimer(name);
    try {
      const result = await fn();
      this.stopTimer(name);
      return result;
    } catch (e) {
      this.stopTimer(name);
      throw e;
    }
  }

  // ── Phases (ordered step tracking) ─────────────────────

  startPhase(name) {
    if (this._activePhase) {
      this.endPhase();
    }
    this._activePhase = { name, start: Date.now() };
    this.sampleMemory(name + '_start');
  }

  endPhase() {
    if (!this._activePhase) return;
    const elapsed = Date.now() - this._activePhase.start;
    this.phases.push({
      name: this._activePhase.name,
      elapsed,
      startedAt: this._activePhase.start - this._runStart,
    });
    this.sampleMemory(this._activePhase.name + '_end');
    this._activePhase = null;
    return elapsed;
  }

  // ── Counters ───────────────────────────────────────────

  increment(name, amount = 1) {
    this.counters[name] = (this.counters[name] || 0) + amount;
  }

  getCount(name) {
    return this.counters[name] || 0;
  }

  // ── Histograms (value distributions) ───────────────────

  record(name, value) {
    if (!this.histograms[name]) this.histograms[name] = [];
    this.histograms[name].push(value);
  }

  getHistogram(name) {
    const values = this.histograms[name] || [];
    if (values.length === 0) return { count: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, sum: 0 };

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: Math.round(sum / sorted.length),
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      sum,
    };
  }

  // ── Memory ─────────────────────────────────────────────

  sampleMemory(label) {
    const mem = process.memoryUsage();
    this.memory.push({
      label,
      timestamp: Date.now() - this._runStart,
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    });
  }

  // ── Report Generation ──────────────────────────────────

  /**
   * Produce a structured JSON metrics object.
   */
  toJSON() {
    const totalElapsed = Date.now() - this._runStart;
    if (this._activePhase) this.endPhase();

    // Find the slowest phases
    const sortedPhases = [...this.phases].sort((a, b) => b.elapsed - a.elapsed);
    const bottlenecks = sortedPhases.slice(0, 5).map(p => ({
      phase: p.name,
      elapsed_ms: p.elapsed,
      pct_of_total: Math.round((p.elapsed / totalElapsed) * 1000) / 10,
    }));

    // Memory peak
    const peakMem = this.memory.reduce((max, m) => m.heapUsed > max.heapUsed ? m : max,
      { heapUsed: 0, rss: 0, label: 'none' });

    return {
      run: {
        startedAt: new Date(this._runStart).toISOString(),
        totalElapsed_ms: totalElapsed,
        totalElapsed_s: Math.round(totalElapsed / 100) / 10,
      },
      phases: this.phases,
      bottlenecks,
      counters: { ...this.counters },
      histograms: Object.fromEntries(
        Object.entries(this.histograms).map(([k, v]) => [k, this.getHistogram(k)])
      ),
      memory: {
        snapshots: this.memory,
        peak: {
          label: peakMem.label,
          heapUsed_mb: peakMem.heapUsed,
          rss_mb: peakMem.rss,
        },
      },
    };
  }

  /**
   * Generate a human-readable markdown summary.
   */
  toMarkdown(extra = {}) {
    const data = this.toJSON();
    const lines = [];

    lines.push('## Timing Summary');
    lines.push('');
    lines.push(`**Total Duration:** ${data.run.totalElapsed_s}s`);
    lines.push('');
    lines.push('| Phase | Duration | % of Total |');
    lines.push('|-------|----------|------------|');
    for (const p of data.phases) {
      const pct = Math.round((p.elapsed / data.run.totalElapsed_ms) * 1000) / 10;
      lines.push(`| ${p.name} | ${(p.elapsed / 1000).toFixed(1)}s | ${pct}% |`);
    }
    lines.push('');

    if (data.bottlenecks.length > 0) {
      lines.push('## Top Bottlenecks');
      lines.push('');
      for (const b of data.bottlenecks) {
        lines.push(`- **${b.phase}**: ${(b.elapsed_ms / 1000).toFixed(1)}s (${b.pct_of_total}%)`);
      }
      lines.push('');
    }

    lines.push('## Counters');
    lines.push('');
    for (const [k, v] of Object.entries(data.counters)) {
      lines.push(`- **${k}:** ${v}`);
    }
    lines.push('');

    const hists = Object.entries(data.histograms).filter(([, v]) => v.count > 0);
    if (hists.length > 0) {
      lines.push('## Distributions');
      lines.push('');
      lines.push('| Metric | Count | Min | Median | Mean | P95 | P99 | Max |');
      lines.push('|--------|-------|-----|--------|------|-----|-----|-----|');
      for (const [name, h] of hists) {
        lines.push(`| ${name} | ${h.count} | ${h.min}ms | ${h.median}ms | ${h.mean}ms | ${h.p95}ms | ${h.p99}ms | ${h.max}ms |`);
      }
      lines.push('');
    }

    lines.push('## Memory');
    lines.push('');
    lines.push(`**Peak Heap:** ${data.memory.peak.heapUsed_mb} MB (at ${data.memory.peak.label})`);
    lines.push(`**Peak RSS:** ${data.memory.peak.rss_mb} MB`);
    lines.push('');
    if (data.memory.snapshots.length > 0) {
      lines.push('| Phase | Heap (MB) | RSS (MB) |');
      lines.push('|-------|-----------|----------|');
      for (const s of data.memory.snapshots) {
        lines.push(`| ${s.label} | ${s.heapUsed} | ${s.rss} |`);
      }
      lines.push('');
    }

    // Append any extra sections
    if (extra.recommendations) {
      lines.push('## Optimization Recommendations');
      lines.push('');
      for (const r of extra.recommendations) {
        lines.push(`- **${r.area}**: ${r.suggestion} _(evidence: ${r.evidence})_`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

module.exports = { MetricsCollector };
