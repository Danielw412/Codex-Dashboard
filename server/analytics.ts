import {
  getModelTokenEvents,
  getRateLimitHistory,
  getThreadTokenEvents
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
  const projectedExhaustionAt = fit.slopePerSecond > 0
    ? now + Math.round((100 - current.usedPercent) / fit.slopePerSecond)
    : null;
  const sustainableSlope = remainingSeconds > 0
    ? Math.max(0, 100 - current.usedPercent) / remainingSeconds
    : 0;
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
  if (projection.projectedExhaustionAt && projection.projectedExhaustionAt < current.resetsAt) {
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

function groupHistory(history: RateLimitWindow[]): RateLimitWindow[][] {
  const groups = new Map<string, RateLimitWindow[]>();
  for (const point of history) {
    const key = `${point.key}:${point.resetsAt}`;
    const group = groups.get(key) ?? [];
    group.push(point);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    group
      .sort((a, b) => a.observedAt - b.observedAt)
      .filter((point, index, all) =>
        index === 0 ||
        point.observedAt !== all[index - 1].observedAt ||
        point.usedPercent !== all[index - 1].usedPercent
      )
  );
}

function assignModelInterval(
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

  const earliest = Math.min(...history.map((point) => point.observedAt));
  const tokenEvents = getModelTokenEvents(earliest);
  const accumulators = new Map<string, EfficiencyAccumulator>();

  for (const group of groupHistory(history)) {
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      const delta = current.usedPercent - previous.usedPercent;
      if (delta <= 0) continue;
      const events = tokenEvents.filter(
        (event) => event.observedAt > previous.observedAt && event.observedAt <= current.observedAt
      );
      const minutes = Math.min(10, Math.max(0.25, (current.observedAt - previous.observedAt) / 60));
      assignModelInterval(accumulators, events, delta, minutes);
    }
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

interface ThreadUsageAccumulator {
  percent: number;
  sampleIntervals: number;
}

type ThreadTokenEvent = ReturnType<typeof getThreadTokenEvents>[number];

function estimateThreadUsageForWindow(
  currentWindow: RateLimitWindow | null,
  lookbackDays: number
): Map<string, ThreadUsageAccumulator> {
  if (!currentWindow) return new Map();

  const history = getRateLimitHistory(
    currentWindow.windowDurationMins,
    undefined,
    lookbackDays
  ).filter((point) => point.key === currentWindow.key);
  const groups = groupHistory(history);
  if (groups.length === 0) return new Map();

  const durationSeconds = currentWindow.windowDurationMins * 60;
  const earliestBankStart = Math.min(
    ...groups.map((group) => group[0].resetsAt - durationSeconds)
  );
  const tokenEvents = getThreadTokenEvents(earliestBankStart);
  const latestBankByThread = new Map<string, { resetAt: number; latestEventAt: number }>();
  const reliableUsageByBank = new Map<number, Map<string, ThreadUsageAccumulator>>();

  for (const group of groups) {
    const resetAt = group[0].resetsAt;
    const bankStart = resetAt - durationSeconds;
    const bankEvents = tokenEvents.filter(
      (event) => event.observedAt >= bankStart && event.observedAt < resetAt
    );

    for (const event of bankEvents) {
      const previous = latestBankByThread.get(event.threadId);
      if (!previous || event.observedAt > previous.latestEventAt) {
        latestBankByThread.set(event.threadId, {
          resetAt,
          latestEventAt: event.observedAt
        });
      }
    }

    if (group.length < 2 || bankEvents.length === 0) continue;

    const accumulators = new Map<string, ThreadUsageAccumulator>();
    const coveredEvents = new Set<ThreadTokenEvent>();
    let bankIsConsistent = true;

    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      const delta = current.usedPercent - previous.usedPercent;

      // A meaningful decrease indicates a quota correction. Continuing to add only
      // later increases could count the same usage twice, so this bank is not reliable.
      if (delta < -0.01) {
        bankIsConsistent = false;
        break;
      }

      const events = bankEvents.filter(
        (event) => event.observedAt > previous.observedAt && event.observedAt <= current.observedAt
      );
      if (events.length === 0 || delta <= 0) continue;

      const byThread = new Map<string, { tokens: number; cost: number }>();
      for (const event of events) {
        const row = byThread.get(event.threadId) ?? { tokens: 0, cost: 0 };
        row.tokens += event.totalTokens;
        row.cost += event.estimatedApiCostUsd;
        byThread.set(event.threadId, row);
      }
      const totalCost = [...byThread.values()].reduce((sum, row) => sum + row.cost, 0);
      const totalTokens = [...byThread.values()].reduce((sum, row) => sum + row.tokens, 0);

      for (const [threadId, row] of byThread) {
        const weight = totalCost > 0
          ? row.cost / totalCost
          : totalTokens > 0
            ? row.tokens / totalTokens
            : 0;
        if (weight <= 0) continue;
        const accumulator = accumulators.get(threadId) ?? { percent: 0, sampleIntervals: 0 };
        accumulator.percent += delta * weight;
        accumulator.sampleIntervals += 1;
        accumulators.set(threadId, accumulator);
      }

      for (const event of events) coveredEvents.add(event);
    }

    if (!bankIsConsistent) continue;

    const eventsByThread = new Map<string, ThreadTokenEvent[]>();
    for (const event of bankEvents) {
      const events = eventsByThread.get(event.threadId) ?? [];
      events.push(event);
      eventsByThread.set(event.threadId, events);
    }

    const reliable = new Map<string, ThreadUsageAccumulator>();
    for (const [threadId, events] of eventsByThread) {
      const estimate = accumulators.get(threadId);
      if (!estimate || !events.every((event) => coveredEvents.has(event))) continue;
      reliable.set(threadId, estimate);
    }
    reliableUsageByBank.set(resetAt, reliable);
  }

  const result = new Map<string, ThreadUsageAccumulator>();
  for (const [threadId, latestBank] of latestBankByThread) {
    const estimate = reliableUsageByBank.get(latestBank.resetAt)?.get(threadId);
    if (estimate) result.set(threadId, estimate);
  }
  return result;
}

export function calculateThreadUsageEstimates(
  fiveHourWindow: RateLimitWindow | null,
  sevenDayWindow: RateLimitWindow | null
): Map<string, {
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
  sampleIntervals: number;
}> {
  const fiveHour = estimateThreadUsageForWindow(fiveHourWindow, 15);
  const sevenDay = estimateThreadUsageForWindow(sevenDayWindow, 30);
  const ids = new Set([...fiveHour.keys(), ...sevenDay.keys()]);
  return new Map(
    [...ids].map((threadId) => {
      const short = fiveHour.get(threadId);
      const weekly = sevenDay.get(threadId);
      return [threadId, {
        fiveHourPercent: short?.percent ?? null,
        sevenDayPercent: weekly?.percent ?? null,
        sampleIntervals: Math.max(short?.sampleIntervals ?? 0, weekly?.sampleIntervals ?? 0)
      }];
    })
  );
}
