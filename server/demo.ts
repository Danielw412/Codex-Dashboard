import type { DashboardOverview, ProjectionPoint, ThreadSummary } from './types.js';

const now = Math.floor(Date.now() / 1000);

function points(start: number, count: number, step: number, startValue: number, rise: number): ProjectionPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * step,
    usedPercent: Math.min(100, startValue + index * rise + Math.sin(index / 2) * 0.8)
  }));
}

const threads: ThreadSummary[] = [
  {
    threadId: 'demo-1',
    title: 'Fix schedule import authentication',
    projectPath: 'C:\\Projects\\ScheduleShare',
    startedAt: now - 7200,
    updatedAt: now - 1800,
    primaryModel: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol'],
    inputTokens: 1_460_000,
    cachedInputTokens: 1_210_000,
    outputTokens: 42_000,
    reasoningOutputTokens: 17_000,
    totalTokens: 1_502_000,
    estimatedApiCostUsd: 3.78,
    pricingStatus: 'exact-model-match',
    sourceFile: 'demo'
  },
  {
    threadId: 'demo-2',
    title: 'Improve mobile schedule grid',
    projectPath: 'C:\\Projects\\ScheduleShare',
    startedAt: now - 86400,
    updatedAt: now - 82500,
    primaryModel: 'gpt-5.6-terra',
    models: ['gpt-5.6-terra'],
    inputTokens: 760_000,
    cachedInputTokens: 640_000,
    outputTokens: 24_000,
    reasoningOutputTokens: 8_000,
    totalTokens: 784_000,
    estimatedApiCostUsd: 1.02,
    pricingStatus: 'exact-model-match',
    sourceFile: 'demo'
  }
];

export function demoOverview(): DashboardOverview {
  const fiveHistory = points(now - 3.5 * 3600, 15, 15 * 60, 5, 2.8);
  fiveHistory.push({ timestamp: now + 1.5 * 3600, usedPercent: 61, projected: true });
  const sevenHistory = points(now - 6 * 86400, 13, 12 * 3600, 10, 3.1);
  sevenHistory.push({ timestamp: now + 86400, usedPercent: 58, projected: true });

  return {
    generatedAt: now,
    connection: { codexConnected: true, authType: 'chatgpt', planType: 'plus', error: null },
    limits: {
      fiveHour: {
        key: 'five-hour',
        label: '5-hour window',
        usedPercent: 47,
        windowDurationMins: 300,
        resetsAt: now + 5400,
        observedAt: now
      },
      sevenDay: {
        key: 'seven-day',
        label: '7-day window',
        usedPercent: 42,
        windowDurationMins: 10_080,
        resetsAt: now + 86400,
        observedAt: now
      },
      other: [],
      fiveHourStatus: 'available'
    },
    projections: {
      fiveHour: {
        projectedPercentAtReset: 61,
        projectedExhaustionAt: null,
        percentPerHour: 9.3,
        paceRatio: 0.53,
        confidence: 'high'
      },
      sevenDay: {
        projectedPercentAtReset: 58,
        projectedExhaustionAt: null,
        percentPerHour: 0.16,
        paceRatio: 0.38,
        confidence: 'medium'
      }
    },
    histories: { fiveHour: fiveHistory, sevenDay: sevenHistory },
    accountDailyUsage: Array.from({ length: 7 }, (_, index) => ({
      date: new Date((now - (6 - index) * 86400) * 1000).toISOString().slice(0, 10),
      tokens: [310000, 840000, 620000, 1250000, 470000, 910000, 720000][index],
      source: 'account' as const
    })),
    localDailyUsage: [],
    totals: {
      threads: 2,
      inputTokens: 2_220_000,
      cachedInputTokens: 1_850_000,
      outputTokens: 66_000,
      reasoningOutputTokens: 25_000,
      totalTokens: 2_286_000,
      estimatedApiCostUsd: 4.8,
      pricedThreads: 2,
      unknownPriceThreads: 0
    },
    threads,
    modelEfficiency: [
      {
        model: 'gpt-5.6-sol',
        estimatedUsagePercent: 19.4,
        activeMinutes: 76,
        minutesPerPercent: 3.92,
        tokens: 1_502_000,
        estimatedApiCostUsd: 3.78,
        sampleIntervals: 18
      },
      {
        model: 'gpt-5.6-terra',
        estimatedUsagePercent: 8.6,
        activeMinutes: 51,
        minutesPerPercent: 5.93,
        tokens: 784_000,
        estimatedApiCostUsd: 1.02,
        sampleIntervals: 11
      }
    ],
    notices: ['Demo mode is enabled. Set DEMO_MODE=false to read your local Codex data.']
  };
}
