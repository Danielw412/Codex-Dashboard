import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateThreadUsageForBank } from './threadUsage.js';
import type { RateLimitWindow } from './types.js';

function point(observedAt: number, usedPercent: number): RateLimitWindow {
  return {
    key: 'five-hour',
    label: '5-hour window',
    usedPercent,
    windowDurationMins: 300,
    resetsAt: 20_000,
    observedAt
  };
}

function event(
  threadId: string,
  observedAt: number,
  totalTokens = 100,
  estimatedApiCostUsd = 1
) {
  return { threadId, observedAt, totalTokens, estimatedApiCostUsd };
}

test('uses the quota before and after the whole thread despite flat intermediate samples', () => {
  const result = estimateThreadUsageForBank(
    [point(0, 20), point(60, 20), point(120, 24)],
    [event('thread-a', 30), event('thread-a', 90)]
  );
  assert.equal(result.get('thread-a')?.percent, 4);
});

test('waits for a quota sample after the final token event', () => {
  const result = estimateThreadUsageForBank(
    [point(0, 20), point(60, 22)],
    [event('thread-a', 30), event('thread-a', 90)]
  );
  assert.equal(result.has('thread-a'), false);
});

test('splits one bracketed quota change between overlapping threads by cost', () => {
  const result = estimateThreadUsageForBank(
    [point(0, 10), point(120, 14)],
    [event('thread-a', 30, 100, 3), event('thread-b', 60, 100, 1)]
  );
  assert.equal(result.get('thread-a')?.percent, 3);
  assert.equal(result.get('thread-b')?.percent, 1);
});

test('keeps sequential threads separate when a quota snapshot divides them', () => {
  const result = estimateThreadUsageForBank(
    [point(0, 10), point(60, 12), point(120, 15)],
    [event('thread-a', 30), event('thread-b', 90)]
  );
  assert.equal(result.get('thread-a')?.percent, 2);
  assert.equal(result.get('thread-b')?.percent, 3);
});

test('extends through a flat post-thread sample until Codex reports the change', () => {
  const result = estimateThreadUsageForBank(
    [point(0, 30), point(60, 30), point(120, 34)],
    [event('thread-a', 30)]
  );
  assert.equal(result.get('thread-a')?.percent, 4);
});

test('rejects a bracket containing a downward quota correction', () => {
  const result = estimateThreadUsageForBank(
    [point(0, 20), point(60, 19), point(120, 24)],
    [event('thread-a', 30)]
  );
  assert.equal(result.has('thread-a'), false);
});
