import {
  getModelTokenEvents,
  getRateLimitHistory
} from './db.js';
import type {
  LimitProjection,
  ModelEfficiency,
  ProjectionPoint,
  RateLimitWindow
} from './types.js';

const EMPTY_PROJECTION: LimitProjection = {
  projectedPercentAtReset: null,
  projectedExhaustionAt: null,
  percentPerHour: null,
  paceRatio: null,
  confidence: 'unavailable'
};

function regression(points: RateLimitWindow[]): { slopePerSecond: number; spanSeconds: number } | null {
  if (points.length < 2) return null;
  const origin = points[0].observedAt;
  const xs = points.map((point) => point.observedAt - origin);
  const ys = points.map((point) => point.usedPercent);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const numerator = xs.reduce((sum, x, index) => sum + (x - meanX) * (ys[index] - meanY), 0);
  const denominator = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  if (denominator === 0) return null;
  return {
    slopePerSecond: Math.max(0, numerator / denominator),
    spanSeconds: xs[xs.length - 1] - xs[0]
  };
}

export function calculateProjection(
  current: RateLimitWindow | null,
  history: RateLimitWindow[]
): LimitProjection {
  if (!current) return EMPTY_PROJECTION;
  const now = Math.floor(Date.now() / 1000);
  const recentWindow = current.windowDurationMins <= 360 ? 90 * 60 : 24 * 60 * 60;
  const recent = history.filter((point) => point.observedAt >= now - recentWindow);
  const fit = regression(recent.length >= 2 ? recent : history);
  if (!fit || fit.spanSeconds < 5 * 60) return EMPTY_PROJECTION;

  const remainingSeconds = Math.max(0, current.resetsAt - now);
  const projected = current.usedPercent + fit.slopePerSecond * remainingSeconds;
  const projectedExhaustionAt =
    fit.slopePerSecond > 0
      ? now + Math.round((100 - current.usedPercent) / fit.slopePerSecond)
      : null;
  const sustainableSlope =
    remainingSeconds > 0 ? Math.max(0, 100 - current.usedPercent) / remainingSeconds : 0;
  const paceRatio = sustainableSlope > 0 ? fit.slopePerSecond / sustainableSlope : null;
  const confidence: LimitProjection['confidence'] =
    fit.spanSeconds >= recentWindow * 0.65 && recent.length >= 8
      ? 'high'
      : fit.spanSeconds >= 30 * 60 && recent.length >= 4
        ? 'medium'
        : 'low';

  return {
    projectedPercentAtReset: Math.max(0, projected),
    projectedExhaustionAt:
      projectedExhaustionAt && projectedExhaustionAt <= current.resetsAt
        ? projectedExhaustionAt
        : null,
    percentPerHour: fit.slopePerSecond * 3600,
    paceRatio,
    confidence
  };
}

export function buildChartPoints(
  current: RateLimitWindow | null,
  history: RateLimitWindow[],
  projection: LimitProjection
): ProjectionPoint[] {
  const points: ProjectionPoint[] = history.map((point) => ({
    timestamp: point.observedAt,
    usedPercent: point.usedPercent
  }));
  if (!current || projection.projectedPercentAtReset === null) return points;

  const nowPoint = points.at(-1);
  if (!nowPoint || nowPoint.timestamp !== current.observedAt) {
    points.push({ timestamp: current.observedAt, usedPercent: current.usedPercent });
  }
  if (
    projection.projectedExhaustionAt &&
    projection.projectedExhaustionAt < current.resetsAt
  ) {
    points.push({
      timestamp: projection.projectedExhaustionAt,
      usedPercent: 100,
      projected: true
    });
  }
  points.push({
    timestamp: current.resetsAt,
    usedPercent: Math.min(130, projection.projectedPercentAtReset),
    projected: true
  });
  return points;
}

interface EfficiencyAccumulator {
  estimatedUsagePercent: number;
  activeMinutes: number;
  tokens: number;
  estimatedApiCostUsd: number;
  sampleIntervals: number;
}

function assignInterval(
  accumulators: Map<string, EfficiencyAccumulator>,
  events: ReturnType<typeof getModelTokenEvents>,
  deltaPercent: number,
  intervalMinutes: number
): void {
  if (events.length === 0 || deltaPercent <= 0) return;
  const grouped = new Map<string, { tokens: number; cost: number }>();
  for (const event of events) {
    const row = grouped.get(event.model) ?? { tokens: 0, cost: 0 };
    row.tokens += event.totalTokens;
    row.cost += event.estimatedApiCostUsd;
    grouped.set(event.model, row);
  }
  const totalCost = [...grouped.values()].reduce((sum, row) => sum + row.cost, 0);
  const totalTokens = [...grouped.values()].reduce((sum, row) => sum + row.tokens, 0);

  for (const [model, row] of grouped) {
    const weight = totalCost > 0 ? row.cost / totalCost : totalTokens > 0 ? row.tokens / totalTokens : 0;
    if (weight <= 0) continue;
    const accumulator = accumulators.get(model) ?? {
      estimatedUsagePercent: 0,
      activeMinutes: 0,
      tokens: 0,
      estimatedApiCostUsd: 0,
      sampleIntervals: 0
    };
    accumulator.estimatedUsagePercent += deltaPercent * weight;
    accumulator.activeMinutes += intervalMinutes * weight;
    accumulator.tokens += row.tokens;
    accumulator.estimatedApiCostUsd += row.cost;
    accumulator.sampleIntervals += 1;
    accumulators.set(model, accumulator);
  }
}

export function calculateModelEfficiency(): ModelEfficiency[] {
  const fiveHourHistory = getRateLimitHistory(300, undefined, 8);
  const sevenDayHistory = getRateLimitHistory(10_080, undefined, 8);
  const history = fiveHourHistory.length >= 3 ? fiveHourHistory : sevenDayHistory;
  if (history.length < 2) return [];

  const earliest = history[0].observedAt;
  const tokenEvents = getModelTokenEvents(earliest);
  const accumulators = new Map<string, EfficiencyAccumulator>();

  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (previous.resetsAt !== current.resetsAt || previous.key !== current.key) continue;
    const delta = current.usedPercent - previous.usedPercent;
    if (delta <= 0) continue;
    const events = tokenEvents.filter(
      (event) => event.observedAt > previous.observedAt && event.observedAt <= current.observedAt
    );
    const minutes = Math.min(10, Math.max(0.25, (current.observedAt - previous.observedAt) / 60));
    assignInterval(accumulators, events, delta, minutes);
  }

  return [...accumulators.entries()]
    .map(([model, row]) => ({
      model,
      ...row,
      minutesPerPercent:
        row.estimatedUsagePercent > 0 ? row.activeMinutes / row.estimatedUsagePercent : null
    }))
    .sort((a, b) => b.estimatedUsagePercent - a.estimatedUsagePercent);
}
