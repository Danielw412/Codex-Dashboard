import { AlertTriangle, CheckCircle2, Clock3, Gauge, TimerReset } from 'lucide-react';
import type { LimitProjection, RateLimitWindow } from '../types';

interface LimitCardProps {
  title: string;
  limit: RateLimitWindow | null;
  projection: LimitProjection;
  missingMessage: string;
}

function formatReset(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const delta = timestamp * 1000 - Date.now();
  if (delta <= 0) return 'Reset pending';
  const minutes = Math.round(delta / 60_000);
  const relative =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return `${relative} · ${date.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })}`;
}

function statusFor(projection: LimitProjection): {
  label: string;
  className: string;
  Icon: typeof Gauge;
} {
  if (projection.paceRatio === null) {
    return { label: 'Collecting trend', className: 'neutral', Icon: Gauge };
  }
  if (projection.paceRatio > 1.15) {
    return { label: 'Above sustainable pace', className: 'danger', Icon: AlertTriangle };
  }
  if (projection.paceRatio > 0.85) {
    return { label: 'Near sustainable pace', className: 'warning', Icon: Clock3 };
  }
  return { label: 'On track', className: 'success', Icon: CheckCircle2 };
}

export function LimitCard({ title, limit, projection, missingMessage }: LimitCardProps) {
  if (!limit) {
    return (
      <section className="panel limit-card unavailable-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Usage window</p>
            <h2>{title}</h2>
          </div>
          <span className="status-chip neutral">Not reported</span>
        </div>
        <div className="unavailable-copy">
          <TimerReset size={24} />
          <div>
            <strong>Window unavailable</strong>
            <p>{missingMessage}</p>
          </div>
        </div>
      </section>
    );
  }

  const status = statusFor(projection);
  const projected = projection.projectedPercentAtReset;
  return (
    <section className="panel limit-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Usage window</p>
          <h2>{title}</h2>
        </div>
        <span className={`status-chip ${status.className}`}>
          <status.Icon size={14} />
          {status.label}
        </span>
      </div>

      <div className="limit-number-row">
        <div>
          <strong>{limit.usedPercent.toFixed(limit.usedPercent < 10 ? 1 : 0)}%</strong>
          <span>used</span>
        </div>
        <div className="limit-projection">
          <span>Projected at reset</span>
          <strong>{projected === null ? '—' : `${Math.round(projected)}%`}</strong>
        </div>
      </div>

      <div className="progress-track" aria-label={`${limit.usedPercent}% used`}>
        <div className="progress-fill" style={{ width: `${Math.min(100, limit.usedPercent)}%` }} />
        {projected !== null && projected > limit.usedPercent && (
          <div
            className="progress-projection"
            style={{
              left: `${Math.min(100, limit.usedPercent)}%`,
              width: `${Math.max(0, Math.min(100, projected) - limit.usedPercent)}%`
            }}
          />
        )}
      </div>

      <div className="limit-meta-grid">
        <div>
          <span>Resets in</span>
          <strong>{formatReset(limit.resetsAt)}</strong>
        </div>
        <div>
          <span>Current burn</span>
          <strong>
            {projection.percentPerHour === null
              ? 'Collecting data'
              : `${projection.percentPerHour.toFixed(1)}% / hour`}
          </strong>
        </div>
        <div>
          <span>Pace ratio</span>
          <strong>
            {projection.paceRatio === null ? '—' : `${projection.paceRatio.toFixed(2)}×`}
          </strong>
        </div>
        <div>
          <span>Trend confidence</span>
          <strong className="capitalize">{projection.confidence}</strong>
        </div>
      </div>
    </section>
  );
}
