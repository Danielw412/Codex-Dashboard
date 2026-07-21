export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface RateLimitWindow {
  key: string;
  label: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  observedAt: number;
}

export interface LimitProjection {
  projectedPercentAtReset: number | null;
  projectedExhaustionAt: number | null;
  percentPerHour: number | null;
  paceRatio: number | null;
  confidence: 'low' | 'medium' | 'high' | 'unavailable';
}

export interface ProjectionPoint {
  timestamp: number;
  usedPercent: number;
  projected?: boolean;
}

export interface DailyUsage {
  date: string;
  tokens: number;
  source: 'account' | 'local';
}

export type PricingStatus = 'exact-model-match' | 'partial' | 'unknown';
export type TitleSource = 'codex-name' | 'codex-preview' | 'prompt' | 'fallback';

export interface PromptMetric extends TokenUsage {
  promptId: string;
  sourceFile: string;
  threadId: string;
  turnId: string | null;
  sequence: number;
  prompt: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  timingEstimated: boolean;
  primaryModel: string;
  models: string[];
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
}

export interface ThreadSummary extends TokenUsage {
  threadId: string;
  title: string;
  titleSource: TitleSource;
  projectPath: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  primaryModel: string;
  models: string[];
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
  sourceFile: string;
  userMessageCount: number;
  reviewerTokens: number;
  partCount: number;
  prompts: PromptMetric[];
  estimatedFiveHourUsagePercent: number | null;
  estimatedSevenDayUsagePercent: number | null;
  usageSampleIntervals: number;
}

export interface ModelEfficiency {
  model: string;
  estimatedUsagePercent: number;
  activeMinutes: number;
  minutesPerPercent: number | null;
  tokens: number;
  estimatedApiCostUsd: number;
  sampleIntervals: number;
}

export interface ModelUsageSummary extends TokenUsage {
  model: string;
  threads: number;
  estimatedApiCostUsd: number;
  pricingStatus: PricingStatus;
}

export interface DashboardOverview {
  generatedAt: number;
  connection: {
    codexConnected: boolean;
    authType: string | null;
    planType: string | null;
    error: string | null;
  };
  limits: {
    fiveHour: RateLimitWindow | null;
    sevenDay: RateLimitWindow | null;
    other: RateLimitWindow[];
    fiveHourStatus: 'available' | 'not-reported';
  };
  projections: {
    fiveHour: LimitProjection;
    sevenDay: LimitProjection;
  };
  histories: {
    fiveHour: ProjectionPoint[];
    sevenDay: ProjectionPoint[];
  };
  accountDailyUsage: DailyUsage[];
  localDailyUsage: DailyUsage[];
  totals: TokenUsage & {
    threads: number;
    estimatedApiCostUsd: number;
    pricedThreads: number;
    unknownPriceThreads: number;
  };
  threads: ThreadSummary[];
  modelEfficiency: ModelEfficiency[];
  modelUsage: ModelUsageSummary[];
  notices: string[];
}
