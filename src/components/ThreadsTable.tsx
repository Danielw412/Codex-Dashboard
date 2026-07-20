import { CircleDollarSign, FolderOpen, Layers3 } from 'lucide-react';
import type { ThreadSummary } from '../types';

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2
  }).format(value);
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function ThreadsTable({ threads }: { threads: ThreadSummary[] }) {
  return (
    <section className="panel threads-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Local history</p>
          <h2>Threads</h2>
          <p className="panel-subtitle">
            Parsed from local Codex session logs. Cost uses API-equivalent public pricing.
          </p>
        </div>
      </div>
      {threads.length === 0 ? (
        <div className="table-empty">No thread usage has been indexed.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Thread</th>
                <th>Model</th>
                <th>Total tokens</th>
                <th>Cached input</th>
                <th>API equivalent</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {threads.map((thread) => (
                <tr key={thread.threadId}>
                  <td>
                    <div className="thread-title">{thread.title}</div>
                    <div className="thread-path" title={thread.projectPath ?? undefined}>
                      <FolderOpen size={12} />
                      {thread.projectPath ?? 'Project path unavailable'}
                    </div>
                  </td>
                  <td>
                    <span className="model-label">{thread.primaryModel}</span>
                    {thread.models.length > 1 && (
                      <span className="muted-inline">
                        <Layers3 size={12} /> {thread.models.length} models
                      </span>
                    )}
                  </td>
                  <td className="numeric-cell">{compact(thread.totalTokens)}</td>
                  <td className="numeric-cell">
                    {compact(thread.cachedInputTokens)}
                    <span className="sub-value">
                      {thread.inputTokens > 0
                        ? `${Math.round((thread.cachedInputTokens / thread.inputTokens) * 100)}% hit`
                        : '—'}
                    </span>
                  </td>
                  <td className="numeric-cell">
                    {thread.estimatedApiCostUsd === null
                      ? 'Unknown'
                      : `$${thread.estimatedApiCostUsd.toFixed(2)}`}
                    <span className={`pricing-state ${thread.pricingStatus}`}>
                      <CircleDollarSign size={11} />
                      {thread.pricingStatus === 'exact-model-match'
                        ? 'Matched'
                        : thread.pricingStatus === 'partial'
                          ? 'Partial'
                          : 'No price'}
                    </span>
                  </td>
                  <td>{formatTime(thread.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
