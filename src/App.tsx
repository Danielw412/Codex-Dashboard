import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Braces,
  Check,
  Coins,
  Database,
  RefreshCw,
  Sparkles,
  Timer,
  Zap
} from 'lucide-react';
import { getOverview, refreshOverview } from './api';
import { DailyTokenChart, ModelEfficiencyChart, RateLimitChart } from './components/Charts';
import { LimitCard } from './components/LimitCard';
import { ThreadsTable } from './components/ThreadsTable';
import type { DashboardOverview } from './types';

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2
  }).format(value);
}

function formatUpdated(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <div className="loading-mark">
        <Braces size={25} />
      </div>
      <div>
        <h1>Loading Codex usage</h1>
        <p>Connecting to the local App Server and indexing session data.</p>
      </div>
    </main>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  note
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <section className="stat-card">
      <div className="stat-icon">
        <Icon size={17} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </section>
  );
}

export default function App() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    try {
      if (force) setRefreshing(true);
      const next = force ? await refreshOverview() : await getOverview();
      setOverview(next);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const dailyData = useMemo(() => {
    if (!overview) return [];
    return overview.accountDailyUsage.length > 0
      ? overview.accountDailyUsage
      : overview.localDailyUsage;
  }, [overview]);

  if (!overview && !error) return <LoadingScreen />;

  if (!overview) {
    return (
      <main className="loading-screen error-screen">
        <div className="loading-mark error-mark">
          <AlertCircle size={25} />
        </div>
        <div>
          <h1>Dashboard unavailable</h1>
          <p>{error}</p>
          <button className="primary-button" onClick={() => void load(false)}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  const cacheHit =
    overview.totals.inputTokens > 0
      ? (overview.totals.cachedInputTokens / overview.totals.inputTokens) * 100
      : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-mark">
            <Braces size={21} />
          </div>
          <div>
            <h1>Codex Usage</h1>
            <p>Quota, tokens, and API-equivalent cost</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="connection-state">
            <span className={overview.connection.codexConnected ? 'online-dot' : 'offline-dot'} />
            <div>
              <strong>{overview.connection.codexConnected ? 'Connected' : 'Offline'}</strong>
              <span>
                {overview.connection.planType
                  ? `${overview.connection.planType} · ${overview.connection.authType ?? 'account'}`
                  : overview.connection.error ?? 'Codex App Server'}
              </span>
            </div>
          </div>
          <div className="last-updated">
            <span>Updated</span>
            <strong>{formatUpdated(overview.generatedAt)}</strong>
          </div>
          <button
            className="icon-button"
            aria-label="Refresh all usage data"
            title="Refresh all usage data"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw size={17} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </header>

      <main className="dashboard">
        {error && (
          <div className="inline-alert danger-alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <section className="intro-row">
          <div>
            <h2>Usage overview</h2>
            <p>
              Live quota snapshots from Codex, plus local token accounting from your saved threads.
            </p>
          </div>
          <div className="method-chip">
            <Check size={14} />
            Local-only storage
          </div>
        </section>

        <div className="limits-grid">
          <LimitCard
            title="5-hour window"
            limit={overview.limits.fiveHour}
            projection={overview.projections.fiveHour}
            missingMessage="The backend is not returning this window right now. Prior samples remain stored, and collection resumes automatically if it returns."
          />
          <LimitCard
            title="7-day window"
            limit={overview.limits.sevenDay}
            projection={overview.projections.sevenDay}
            missingMessage="The backend is not returning a weekly window for this account."
          />
        </div>

        <div className="stats-grid">
          <StatCard
            icon={Database}
            label="Total tokens indexed"
            value={compact(overview.totals.totalTokens)}
            note={`${compact(overview.totals.inputTokens)} input · ${compact(overview.totals.outputTokens)} output`}
          />
          <StatCard
            icon={Coins}
            label="API-equivalent cost"
            value={`$${overview.totals.estimatedApiCostUsd.toFixed(2)}`}
            note={`${overview.totals.pricedThreads}/${overview.totals.threads} threads priced`}
          />
          <StatCard
            icon={Zap}
            label="Input cache hit"
            value={`${cacheHit.toFixed(1)}%`}
            note={`${compact(overview.totals.cachedInputTokens)} cached input tokens`}
          />
          <StatCard
            icon={Sparkles}
            label="Threads indexed"
            value={overview.totals.threads.toLocaleString()}
            note={`${overview.modelEfficiency.length} models correlated to quota`}
          />
        </div>

        <div className="charts-grid">
          <RateLimitChart
            title="5-hour trajectory"
            subtitle={
              overview.limits.fiveHour
                ? 'Observed usage with a linear projection to the current reset.'
                : 'Historical samples remain visible while the window is not reported.'
            }
            points={overview.histories.fiveHour}
            range="short"
          />
          <RateLimitChart
            title="7-day trajectory"
            subtitle="Observed weekly quota usage and the projected endpoint at reset."
            points={overview.histories.sevenDay}
            range="long"
          />
        </div>

        <div className="secondary-grid">
          <DailyTokenChart data={dailyData} />
          <ModelEfficiencyChart data={overview.modelEfficiency} />
        </div>

        <ThreadsTable threads={overview.threads} />

        <section className="panel methodology-panel">
          <div className="methodology-heading">
            <div className="methodology-icon">
              <Timer size={18} />
            </div>
            <div>
              <h2>Accuracy notes</h2>
              <p>What is measured directly and what is estimated.</p>
            </div>
          </div>
          <div className="notice-grid">
            {overview.notices.map((notice) => (
              <div className="notice-row" key={notice}>
                <span />
                <p>{notice}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
