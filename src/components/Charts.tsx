import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import type {
  DailyUsage,
  ModelEfficiency,
  ModelUsageSummary,
  ProjectionPoint
} from '../types';

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value);
}

function timeLabel(timestamp: number, range: 'short' | 'long'): string {
  const date = new Date(timestamp * 1000);
  return range === 'short'
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

type TrendRow = ProjectionPoint & {
  actual: number | null;
  projection: number | null;
};

function buildTrendData(points: ProjectionPoint[]): TrendRow[] {
  return points.map((point) => ({
    ...point,
    actual: point.projected ? null : point.usedPercent,
    projection: point.projected ? point.usedPercent : null
  }));
}

const tooltipStyle = {
  background: 'var(--tooltip-bg)',
  border: '1px solid var(--border-strong)',
  borderRadius: 12,
  boxShadow: 'var(--shadow-lg)'
};

export function RateLimitChart({
  title,
  subtitle,
  points,
  range
}: {
  title: string;
  subtitle: string;
  points: ProjectionPoint[];
  range: 'short' | 'long';
}) {
  const base = buildTrendData(points);
  const firstProjectedIndex = base.findIndex((point) => point.projected);
  const data = [...base];
  if (firstProjectedIndex > 0) {
    const previous = base[firstProjectedIndex - 1];
    data[firstProjectedIndex - 1] = { ...previous, projection: previous.usedPercent };
  }
  const maxValue = Math.max(100, ...points.map((point) => point.usedPercent));

  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Quota trend</p>
          <h2>{title}</h2>
          <p className="panel-subtitle">{subtitle}</p>
        </div>
      </div>
      {points.length < 2 ? (
        <div className="chart-empty">More snapshots are needed before a trend can be drawn.</div>
      ) : (
        <div className="chart-frame">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id={`usageFill-${range}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-primary)" stopOpacity={0.26} />
                  <stop offset="100%" stopColor="var(--chart-primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--grid-line)" vertical={false} />
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(value) => timeLabel(value, range)}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={34}
              />
              <YAxis
                domain={[0, Math.ceil(maxValue / 20) * 20]}
                tickFormatter={(value) => `${value}%`}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(value) => new Date(Number(value) * 1000).toLocaleString()}
                formatter={(value, name) => [
                  `${Number(value).toFixed(1)}%`,
                  name === 'projection' ? 'Projected' : 'Actual'
                ]}
              />
              <ReferenceLine y={100} stroke="var(--danger)" strokeDasharray="4 5" opacity={0.65} />
              <Area
                type="linear"
                dataKey="actual"
                stroke="var(--chart-primary)"
                strokeWidth={2.5}
                fill={`url(#usageFill-${range})`}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="linear"
                dataKey="projection"
                stroke="var(--chart-projection)"
                strokeWidth={2.2}
                strokeDasharray="6 5"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export function DailyTokenChart({ data }: { data: DailyUsage[] }) {
  return (
    <section className="panel chart-panel daily-chart-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Token activity</p>
          <h2>Last 7 days</h2>
          <p className="panel-subtitle">Account totals when available, otherwise local session logs.</p>
        </div>
      </div>
      {data.length === 0 ? (
        <div className="chart-empty">No daily token history was returned yet.</div>
      ) : (
        <div className="chart-frame compact-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
              <CartesianGrid stroke="var(--grid-line)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(value) =>
                  new Date(`${value}T12:00:00`).toLocaleDateString([], { weekday: 'short' })
                }
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={compactNumber}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--hover-surface)' }}
                contentStyle={tooltipStyle}
                formatter={(value) => [Number(value).toLocaleString(), 'Tokens']}
              />
              <Bar dataKey="tokens" fill="var(--chart-secondary)" radius={[6, 6, 2, 2]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export function ModelEfficiencyChart({ data }: { data: ModelEfficiency[] }) {
  const chartData = data.filter((row) => row.minutesPerPercent !== null).slice(0, 8);
  const average = chartData.length > 0
    ? chartData.reduce((sum, row) => sum + (row.minutesPerPercent ?? 0), 0) / chartData.length
    : null;

  return (
    <section className="panel chart-panel efficiency-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Estimated model efficiency</p>
          <h2>Minutes per 1% of quota</h2>
          <p className="panel-subtitle">Higher means the model consumed the observed quota more slowly.</p>
        </div>
        {average !== null && (
          <div className="average-box">
            <span>Average</span>
            <strong>{average.toFixed(1)} min</strong>
          </div>
        )}
      </div>
      {chartData.length === 0 ? (
        <div className="chart-empty">Usage and token samples have not overlapped yet.</div>
      ) : (
        <div className="chart-frame compact-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 20, bottom: 0, left: 32 }}>
              <CartesianGrid stroke="var(--grid-line)" horizontal={false} />
              <XAxis
                type="number"
                unit="m"
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="model"
                width={112}
                tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--hover-surface)' }}
                contentStyle={tooltipStyle}
                formatter={(value) => [`${Number(value).toFixed(2)} minutes`, 'Per 1%']}
              />
              {average !== null && (
                <ReferenceLine x={average} stroke="var(--chart-projection)" strokeDasharray="4 4" />
              )}
              <Bar dataKey="minutesPerPercent" fill="var(--chart-tertiary)" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export function ModelTokenChart({ data }: { data: ModelUsageSummary[] }) {
  const chartData = [...data].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10);
  return (
    <section className="panel chart-panel model-breakdown-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Model totals</p>
          <h2>Tokens by model</h2>
          <p className="panel-subtitle">Includes main-agent, subagent, and auto-review token events.</p>
        </div>
      </div>
      {chartData.length === 0 ? (
        <div className="chart-empty">No model token data has been indexed.</div>
      ) : (
        <div className="chart-frame model-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 38 }}>
              <CartesianGrid stroke="var(--grid-line)" horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={compactNumber}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="model"
                width={130}
                tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--hover-surface)' }}
                contentStyle={tooltipStyle}
                formatter={(value) => [Number(value).toLocaleString(), 'Tokens']}
              />
              <Bar dataKey="totalTokens" fill="var(--chart-secondary)" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

export function ModelCostChart({ data }: { data: ModelUsageSummary[] }) {
  const chartData = data
    .filter((row) => row.estimatedApiCostUsd > 0)
    .sort((a, b) => b.estimatedApiCostUsd - a.estimatedApiCostUsd)
    .slice(0, 10);
  return (
    <section className="panel chart-panel model-breakdown-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">API-equivalent pricing</p>
          <h2>Estimated cost by model</h2>
          <p className="panel-subtitle">Unpriced internal models are omitted from this graph.</p>
        </div>
      </div>
      {chartData.length === 0 ? (
        <div className="chart-empty">No model has a matched API price yet.</div>
      ) : (
        <div className="chart-frame model-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 38 }}>
              <CartesianGrid stroke="var(--grid-line)" horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="model"
                width={130}
                tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: 'var(--hover-surface)' }}
                contentStyle={tooltipStyle}
                formatter={(value) => [`$${Number(value).toFixed(4)}`, 'API equivalent']}
              />
              <Bar dataKey="estimatedApiCostUsd" fill="var(--chart-tertiary)" radius={[0, 6, 6, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
