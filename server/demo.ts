import type { DashboardOverview, ProjectionPoint, PromptMetric, ThreadSummary } from './types.js';

const now = Math.floor(Date.now() / 1000);

function points(start: number, count: number, step: number, startValue: number, rise: number): ProjectionPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * step,
    usedPercent: Math.min(100, startValue + index * rise + Math.sin(index / 2) * 0.8)
  }));
}

function demoPrompt(
  promptId: string,
  threadId: string,
  sequence: number,
  prompt: string,
  model: string,
  startedAt: number,
  durationMs: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  cost: number
): PromptMetric {
  return {
    promptId,
    sourceFile: 'demo',
    threadId,
    turnId: `turn-${promptId}`,
    sequence,
    prompt,
    startedAt,
    completedAt: startedAt + Math.round(durationMs / 1000),
    durationMs,
    timeToFirstTokenMs: 3_200,
    timingEstimated: false,
    primaryModel: model,
    models: [model],
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: Math.round(outputTokens * 0.35),
    totalTokens: inputTokens + outputTokens,
    estimatedApiCostUsd: cost,
    pricingStatus: 'exact-model-match'
  };
}

const threadOnePrompts = [
  demoPrompt('demo-p1', 'demo-1', 1, 'Fix schedule import authentication and verify the worker flow.', 'gpt-5.6-sol', now - 7200, 1_160_000, 910_000, 760_000, 29_000, 2.3),
  demoPrompt('demo-p2', 'demo-1', 2, 'Run the tests and fix the remaining mobile regression.', 'gpt-5.6-sol', now - 5100, 640_000, 550_000, 450_000, 13_000, 1.48)
];
const threadTwoPrompts = [
  demoPrompt('demo-p3', 'demo-2', 1, 'Improve the mobile schedule grid and reduce horizontal overflow.', 'gpt-5.6-terra', now - 86_400, 780_000, 760_000, 640_000, 24_000, 1.02)
];

const threads: ThreadSummary[] = [
  {
    threadId: 'demo-1',
    title: 'Schedule import authentication',
    titleSource: 'codex-name',
    projectPath: 'C:\\Projects\\ScheduleShare',
    startedAt: now - 7200,
    updatedAt: now - 1800,
    primaryModel: 'gpt-5.6-sol',
    models: ['gpt-5.6-sol', 'codex-auto-review'],
    inputTokens: 1_460_000,
    cachedInputTokens: 1_210_000,
    outputTokens: 42_000,
    reasoningOutputTokens: 17_000,
    totalTokens: 1_502_000,
    estimatedApiCostUsd: 3.78,
    pricingStatus: 'partial',
    sourceFile: 'demo',
    userMessageCount: 2,
    reviewerTokens: 148_000,
    partCount: 3,
    prompts: threadOnePrompts,
    estimatedFiveHourUsagePercent: 9.8,
    estimatedSevenDayUsagePercent: 3.4,
    usageSampleIntervals: 12
  },
  {
    threadId: 'demo-2',
    title: 'Cleaner mobile schedule grid',
    titleSource: 'codex-name',
    projectPath: 'C:\\Projects\\ScheduleShare',
    startedAt: now - 86_400,
    updatedAt: now - 82_500,
    primaryModel: 'gpt-5.6-terra',
    models: ['gpt-5.6-terra'],
    inputTokens: 760_000,
    cachedInputTokens: 640_000,
    outputTokens: 24_000,
    reasoningOutputTokens: 8_000,
    totalTokens: 784_000,
    estimatedApiCostUsd: 1.02,
    pricingStatus: 'exact-model-match',
    sourceFile: 'demo',
    userMessageCount: 1,
    reviewerTokens: 0,
    partCount: 1,
    prompts: threadTwoPrompts,
    estimatedFiveHourUsagePercent: null,
    estimatedSevenDayUsagePercent: 1.7,
    usageSampleIntervals: 6
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
      unknownPriceThreads: 1
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
    modelUsage: [
      {
        model: 'gpt-5.6-sol',
        threads: 1,
        inputTokens: 1_312_000,
        cachedInputTokens: 1_095_000,
        outputTokens: 42_000,
        reasoningOutputTokens: 17_000,
        totalTokens: 1_354_000,
        estimatedApiCostUsd: 3.78,
        pricingStatus: 'exact-model-match'
      },
      {
        model: 'codex-auto-review',
        threads: 1,
        inputTokens: 145_000,
        cachedInputTokens: 115_000,
        outputTokens: 3_000,
        reasoningOutputTokens: 1_000,
        totalTokens: 148_000,
        estimatedApiCostUsd: 0,
        pricingStatus: 'unknown'
      },
      {
        model: 'gpt-5.6-terra',
        threads: 1,
        inputTokens: 760_000,
        cachedInputTokens: 640_000,
        outputTokens: 24_000,
        reasoningOutputTokens: 8_000,
        totalTokens: 784_000,
        estimatedApiCostUsd: 1.02,
        pricingStatus: 'exact-model-match'
      }
    ],
    notices: ['Demo mode is enabled. Set DEMO_MODE=false to read your local Codex data.']
  };
}
