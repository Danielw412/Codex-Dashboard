import type { RateLimitWindow } from './types.js';

export interface ThreadUsageEvent {
  observedAt: number;
  threadId: string;
  totalTokens: number;
  estimatedApiCostUsd: number;
}

export interface ThreadUsageAccumulator {
  percent: number;
  sampleIntervals: number;
}

interface ThreadBracket {
  threadId: string;
  startIndex: number;
  endIndex: number;
  events: ThreadUsageEvent[];
}

interface BracketGroup {
  startIndex: number;
  endIndex: number;
  brackets: ThreadBracket[];
}

function findSnapshotBefore(history: RateLimitWindow[], timestamp: number): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].observedAt < timestamp) return index;
  }
  return -1;
}

function findSnapshotAfter(history: RateLimitWindow[], timestamp: number): number {
  return history.findIndex((point) => point.observedAt > timestamp);
}

function extendToReportedChange(
  history: RateLimitWindow[],
  startIndex: number,
  endIndex: number
): number {
  const startingPercent = history[startIndex].usedPercent;
  let index = endIndex;
  while (
    index + 1 < history.length &&
    Math.abs(history[index].usedPercent - startingPercent) <= 0.01
  ) {
    index += 1;
  }
  return index;
}

function mergeOverlappingBrackets(brackets: ThreadBracket[]): BracketGroup[] {
  const ordered = [...brackets].sort(
    (a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex
  );
  const groups: BracketGroup[] = [];

  for (const bracket of ordered) {
    const current = groups.at(-1);
    if (!current || bracket.startIndex >= current.endIndex) {
      groups.push({
        startIndex: bracket.startIndex,
        endIndex: bracket.endIndex,
        brackets: [bracket]
      });
      continue;
    }

    current.endIndex = Math.max(current.endIndex, bracket.endIndex);
    current.brackets.push(bracket);
  }
  return groups;
}

export function estimateThreadUsageForBank(
  rawHistory: RateLimitWindow[],
  bankEvents: ThreadUsageEvent[]
): Map<string, ThreadUsageAccumulator> {
  const history = [...rawHistory]
    .sort((a, b) => a.observedAt - b.observedAt)
    .filter((point, index, all) =>
      index === 0 ||
      point.observedAt !== all[index - 1].observedAt ||
      point.usedPercent !== all[index - 1].usedPercent
    );
  if (history.length < 2 || bankEvents.length === 0) return new Map();

  const eventsByThread = new Map<string, ThreadUsageEvent[]>();
  for (const event of bankEvents) {
    const events = eventsByThread.get(event.threadId) ?? [];
    events.push(event);
    eventsByThread.set(event.threadId, events);
  }

  const brackets: ThreadBracket[] = [];
  for (const [threadId, unsortedEvents] of eventsByThread) {
    const events = [...unsortedEvents].sort((a, b) => a.observedAt - b.observedAt);
    const startIndex = findSnapshotBefore(history, events[0].observedAt);
    const firstAfterIndex = findSnapshotAfter(history, events.at(-1)!.observedAt);
    if (startIndex < 0 || firstAfterIndex < 0) continue;

    const endIndex = extendToReportedChange(history, startIndex, firstAfterIndex);
    if (endIndex <= startIndex) continue;
    brackets.push({ threadId, startIndex, endIndex, events });
  }

  const result = new Map<string, ThreadUsageAccumulator>();
  for (const group of mergeOverlappingBrackets(brackets)) {
    let consistent = true;
    let sampleIntervals = 0;
    for (let index = group.startIndex + 1; index <= group.endIndex; index += 1) {
      const delta = history[index].usedPercent - history[index - 1].usedPercent;
      if (delta < -0.01) {
        consistent = false;
        break;
      }
      if (delta > 0.01) sampleIntervals += 1;
    }
    if (!consistent) continue;

    const deltaPercent =
      history[group.endIndex].usedPercent - history[group.startIndex].usedPercent;
    if (deltaPercent <= 0.01) continue;

    const totalsByThread = new Map<string, { tokens: number; cost: number }>();
    for (const bracket of group.brackets) {
      const total = totalsByThread.get(bracket.threadId) ?? { tokens: 0, cost: 0 };
      for (const event of bracket.events) {
        total.tokens += event.totalTokens;
        total.cost += event.estimatedApiCostUsd;
      }
      totalsByThread.set(bracket.threadId, total);
    }

    const totalCost = [...totalsByThread.values()].reduce((sum, row) => sum + row.cost, 0);
    const totalTokens = [...totalsByThread.values()].reduce((sum, row) => sum + row.tokens, 0);
    for (const [threadId, row] of totalsByThread) {
      const weight = totalCost > 0
        ? row.cost / totalCost
        : totalTokens > 0
          ? row.tokens / totalTokens
          : 0;
      if (weight <= 0) continue;
      result.set(threadId, {
        percent: deltaPercent * weight,
        sampleIntervals: Math.max(1, sampleIntervals)
      });
    }
  }

  return result;
}
