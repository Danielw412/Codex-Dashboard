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
  getRateLimitHistory,
  getThreadSummaries,
  getTokenTotals,
  insertRateLimitSnapshot,
  upsertAccountDailyUsage
} from './db.js';
import {
  buildChartPoints,
  calculateModelEfficiency,
  calculateProjection
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

const codex = new AppServerClient();
let limits: RateLimitWindow[] = [];
let accountState: { authType: string | null; planType: string | null } = {
  authType: null,
  planType: null
};
let connectionError: string | null = null;
let refreshInProgress: Promise<void> | null = null;
let lastAccountUsageRefresh = 0;

codex.on('diagnostic', (message: string) => {
  if (process.env.DEBUG_CODEX_DASHBOARD === 'true') console.log(`[codex] ${message}`);
});
codex.on('account/rateLimits/updated', () => {
  setTimeout(() => void refreshCodexData(false), 500);
});

function pickWindow(duration: number): RateLimitWindow | null {
  return (
    limits.find((limit) => Math.abs(limit.windowDurationMins - duration) <= (duration < 1000 ? 5 : 60)) ??
    null
  );
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
          // Token-activity summaries are not available for every auth mode/account.
          console.warn('Account usage summary unavailable:', (error as Error).message);
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
    : getRateLimitHistory(300, undefined, 1);
  const sevenHistory = sevenDay
    ? getRateLimitHistory(10_080, sevenDay.resetsAt, 8)
    : getRateLimitHistory(10_080, undefined, 8);
  const fiveProjection = calculateProjection(fiveHour, fiveHistory);
  const sevenProjection = calculateProjection(sevenDay, sevenHistory);
  const threads = getThreadSummaries(100);
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
      `${totals.unknownPriceThreads} thread(s) use a model that is not in config/pricing.json, so their cost is not included.`
    );
  }
  if (connectionError) notices.push(`Codex account connection error: ${connectionError}`);
  notices.push(
    'API-equivalent cost is an estimate based on public API token prices; it is not your ChatGPT subscription charge.'
  );
  notices.push(
    'Per-model minutes per 1% is estimated by correlating quota changes with local token events. It becomes more reliable after the dashboard has collected several samples.'
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
