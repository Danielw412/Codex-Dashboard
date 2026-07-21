import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AppServerClient } from './codex/AppServerClient.js';
import {
  normalizeAccount,
  normalizeDailyUsage,
  normalizeRateLimits
} from './codex/normalize.js';
import {
  getAccountDailyUsage,
  getLocalDailyUsage,
  getModelUsageSummaries,
  getRateLimitHistory,
  getThreadSummaries,
  getTokenTotals,
  insertRateLimitSnapshot,
  upsertAccountDailyUsage,
  upsertThreadMetadata
} from './db.js';
import {
  buildChartPoints,
  calculateModelEfficiency,
  calculateProjection,
  calculateThreadUsageEstimates
} from './analytics.js';
import { demoOverview } from './demo.js';
import { loadPricingConfig } from './pricing.js';
import { scanCodexSessions } from './sessionLogs.js';
import type { DashboardOverview, RateLimitWindow } from './types.js';

const app = express();
app.use(express.json());

const port = Number(process.env.PORT || 8787);
const demoMode = process.env.DEMO_MODE === 'true';
const rateLimitPollMs = Number(process.env.RATE_LIMIT_POLL_MS || 60_000);
const accountUsagePollMs = Number(process.env.ACCOUNT_USAGE_POLL_MS || 900_000);
const sessionScanMs = Number(process.env.SESSION_SCAN_MS || 120_000);
const threadMetadataPollMs = Number(process.env.THREAD_METADATA_POLL_MS || 900_000);

const codex = new AppServerClient();
let limits: RateLimitWindow[] = [];
let accountState: { authType: string | null; planType: string | null } = {
  authType: null,
  planType: null
};
let connectionError: string | null = null;
let refreshInProgress: Promise<void> | null = null;
let lastAccountUsageRefresh = 0;
let lastThreadMetadataRefresh = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

codex.on('diagnostic', (message: string) => {
  if (process.env.DEBUG_CODEX_DASHBOARD === 'true') console.log(`[codex] ${message}`);
});
codex.on('account/rateLimits/updated', () => {
  setTimeout(() => void refreshCodexData(false), 500);
});
codex.on('thread/name/updated', () => {
  lastThreadMetadataRefresh = 0;
  setTimeout(() => void refreshCodexData(false), 500);
});

function pickWindow(duration: number): RateLimitWindow | null {
  return (
    limits.find((limit) => Math.abs(limit.windowDurationMins - duration) <= (duration < 1000 ? 5 : 60)) ??
    null
  );
}

async function refreshThreadMetadata(): Promise<void> {
  const collected: Array<{
    threadId: string;
    displayName: string | null;
    preview: string | null;
    updatedAt: number;
  }> = [];

  for (const archived of [false, true]) {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await codex.request('thread/list', {
        cursor,
        limit: 100,
        archived,
        sortKey: 'updated_at',
        sortDirection: 'desc'
      }, 30_000);
      if (!isRecord(result)) break;
      const data = Array.isArray(result.data) ? result.data : [];
      for (const value of data) {
        if (!isRecord(value)) continue;
        const threadId = firstText(value, ['id', 'threadId', 'thread_id']);
        if (!threadId) continue;
        collected.push({
          threadId,
          displayName: firstText(value, ['name', 'title', 'threadName', 'displayName']),
          preview: firstText(value, ['preview', 'promptPreview']),
          updatedAt: parseTime(value.updatedAt ?? value.updated_at ?? value.recencyAt ?? value.createdAt)
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
  }

  if (collected.length > 0) upsertThreadMetadata(collected);
  lastThreadMetadataRefresh = Date.now();
}

async function refreshCodexData(forceAccountUsage = false): Promise<void> {
  if (demoMode) return;
  if (refreshInProgress) return refreshInProgress;

  refreshInProgress = (async () => {
    try {
      await codex.start();
      const accountResult = await codex.request('account/read', { refreshToken: false });
      accountState = normalizeAccount(accountResult);

      const rateResult = await codex.request('account/rateLimits/read');
      const normalized = normalizeRateLimits(rateResult);
      if (normalized.length > 0) {
        limits = normalized;
        for (const limit of normalized) insertRateLimitSnapshot(limit);
      }
      connectionError = null;

      const now = Date.now();
      if (forceAccountUsage || now - lastAccountUsageRefresh >= accountUsagePollMs) {
        try {
          const usageResult = await codex.request('account/usage/read');
          const daily = normalizeDailyUsage(usageResult);
          if (daily.length > 0) upsertAccountDailyUsage(daily);
          lastAccountUsageRefresh = now;
        } catch (error) {
          console.warn('Account usage summary unavailable:', (error as Error).message);
        }
      }

      if (forceAccountUsage || now - lastThreadMetadataRefresh >= threadMetadataPollMs) {
        try {
          await refreshThreadMetadata();
        } catch (error) {
          console.warn('Thread titles unavailable from App Server:', (error as Error).message);
          lastThreadMetadataRefresh = now;
        }
      }
    } catch (error) {
      connectionError = (error as Error).message;
      console.warn('Could not refresh Codex account data:', connectionError);
    }
  })().finally(() => {
    refreshInProgress = null;
  });

  return refreshInProgress;
}

async function refreshSessions(): Promise<void> {
  if (demoMode) return;
  const result = await scanCodexSessions();
  if (process.env.DEBUG_CODEX_DASHBOARD === 'true') {
    console.log(`Session scan: ${result.scanned} found, ${result.updated} updated, ${result.errors} errors`);
  }
}

function buildOverview(): DashboardOverview {
  if (demoMode) return demoOverview();

  const fiveHour = pickWindow(300);
  const sevenDay = pickWindow(10_080);
  const fiveHistory = fiveHour
    ? getRateLimitHistory(300, fiveHour.resetsAt, 2)
    : getRateLimitHistory(300, undefined, 8);
  const sevenHistory = sevenDay
    ? getRateLimitHistory(10_080, sevenDay.resetsAt, 8)
    : getRateLimitHistory(10_080, undefined, 15);
  const fiveProjection = calculateProjection(fiveHour, fiveHistory);
  const sevenProjection = calculateProjection(sevenDay, sevenHistory);
  const usageEstimates = calculateThreadUsageEstimates(fiveHour, sevenDay);
  const threads = getThreadSummaries(100).map((thread) => {
    const usage = usageEstimates.get(thread.threadId);
    return {
      ...thread,
      estimatedFiveHourUsagePercent: usage?.fiveHourPercent ?? null,
      estimatedSevenDayUsagePercent: usage?.sevenDayPercent ?? null,
      usageSampleIntervals: usage?.sampleIntervals ?? 0
    };
  });
  const totals = getTokenTotals();
  const notices: string[] = [];

  if (!fiveHour) {
    notices.push(
      'Codex is not currently reporting a 5-hour window. The dashboard keeps prior 5-hour history and will resume automatically if the window returns.'
    );
  }
  if (!sevenDay) notices.push('Codex is not currently reporting a 7-day rate-limit window.');
  if (threads.length === 0) {
    notices.push(
      'No local session token events were found. Check CODEX_HOME or create a new Codex thread, then refresh.'
    );
  }
  if (totals.unknownPriceThreads > 0) {
    notices.push(
      `${totals.unknownPriceThreads} thread(s) include a model that is not in config/pricing.json, so part of their cost may be unavailable.`
    );
  }
  if (connectionError) notices.push(`Codex account connection error: ${connectionError}`);
  notices.push(
    'Thread quota usage is estimated only within the specific quota bank active at the thread’s latest token event. It stays blank unless every local token event in that bank is bracketed by consistent quota snapshots.'
  );
  notices.push(
    'Prompt duration is exact when Codex reports a completed turn. Steering messages inside one turn use the time until the next prompt or turn completion.'
  );
  notices.push(
    'API-equivalent cost is an estimate based on public API token prices; it is not your ChatGPT subscription charge.'
  );

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    connection: {
      codexConnected: codex.connected && !connectionError,
      ...accountState,
      error: connectionError
    },
    limits: {
      fiveHour,
      sevenDay,
      other: limits.filter(
        (limit) =>
          Math.abs(limit.windowDurationMins - 300) > 5 &&
          Math.abs(limit.windowDurationMins - 10_080) > 60
      ),
      fiveHourStatus: fiveHour ? 'available' : 'not-reported'
    },
    projections: {
      fiveHour: fiveProjection,
      sevenDay: sevenProjection
    },
    histories: {
      fiveHour: buildChartPoints(fiveHour, fiveHistory, fiveProjection),
      sevenDay: buildChartPoints(sevenDay, sevenHistory, sevenProjection)
    },
    accountDailyUsage: getAccountDailyUsage(7),
    localDailyUsage: getLocalDailyUsage(7),
    totals,
    threads,
    modelEfficiency: calculateModelEfficiency(),
    modelUsage: getModelUsageSummaries(),
    notices
  };
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    demoMode,
    codexConnected: codex.connected,
    error: connectionError
  });
});

app.get('/api/overview', (_request, response) => {
  response.json(buildOverview());
});

app.get('/api/pricing', (_request, response) => {
  response.json(loadPricingConfig());
});

app.post('/api/refresh', async (_request, response) => {
  lastThreadMetadataRefresh = 0;
  await Promise.all([refreshCodexData(true), refreshSessions()]);
  response.json(buildOverview());
});

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const clientDist = path.resolve(currentDir, '../dist');
app.use(express.static(clientDist));
app.use((request, response, next) => {
  if (request.path.startsWith('/api/')) return next();
  response.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(port, () => {
  console.log(`Codex Usage Dashboard server: http://localhost:${port}`);
  if (demoMode) console.log('DEMO_MODE is enabled.');
});

void refreshCodexData(true);
void refreshSessions();
setInterval(() => void refreshCodexData(false), rateLimitPollMs).unref();
setInterval(() => void refreshSessions(), sessionScanMs).unref();

process.on('SIGINT', () => {
  codex.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  codex.stop();
  process.exit(0);
});
