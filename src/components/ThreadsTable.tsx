import { Fragment, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FolderOpen,
  Gauge,
  MessageSquareText,
  ShieldCheck,
  TimerReset,
  Zap
} from 'lucide-react';
import type { PromptMetric, ThreadSummary } from '../types';

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

function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  if (minutes < 60) return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours}h ${restMinutes}m`;
}

function formatUsage(value: number | null): string {
  if (value === null) return '—';
  if (value < 0.05) return '<0.1%';
  return `~${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null);
  return valid.length > 0 ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function TokenDistribution({ input, cached, output }: { input: number; cached: number; output: number }) {
  const uncached = Math.max(0, input - cached);
  const denominator = Math.max(1, uncached + cached + output);
  const rows = [
    { label: 'Cached input', value: cached, className: 'cached' },
    { label: 'Uncached input', value: uncached, className: 'uncached' },
    { label: 'Output', value: output, className: 'output' }
  ];

  return (
    <div className="distribution-block">
      <div className="distribution-heading">
        <div>
          <span>Token distribution</span>
          <strong>{compact(input + output)} billable text tokens</strong>
        </div>
        <small>Cached input is part of total input, not an additional token category.</small>
      </div>
      <div className="distribution-track" aria-label="Token distribution">
        {rows.map((row) => (
          <span
            key={row.label}
            className={`distribution-segment ${row.className}`}
            style={{ width: `${(row.value / denominator) * 100}%` }}
            title={`${row.label}: ${row.value.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="distribution-legend">
        {rows.map((row) => (
          <div key={row.label}>
            <span className={`legend-dot ${row.className}`} />
            <span>{row.label}</span>
            <strong>{compact(row.value)}</strong>
            <small>{((row.value / denominator) * 100).toFixed(1)}%</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function PromptRow({ prompt }: { prompt: PromptMetric }) {
  return (
    <article className="prompt-row">
      <div className="prompt-index">{prompt.sequence}</div>
      <div className="prompt-copy">
        <strong title={prompt.prompt}>{prompt.prompt}</strong>
        <span>{formatTime(prompt.startedAt)}</span>
      </div>
      <div className="prompt-model">
        <span className="model-label">{prompt.primaryModel}</span>
      </div>
      <div className="prompt-metric">
        <span>Active span</span>
        <strong>{formatDuration(prompt.durationMs)}</strong>
        {prompt.timingEstimated && <small>derived</small>}
      </div>
      <div className="prompt-metric">
        <span>First token</span>
        <strong>{formatDuration(prompt.timeToFirstTokenMs)}</strong>
      </div>
      <div className="prompt-metric">
        <span>Tokens</span>
        <strong>{compact(prompt.totalTokens)}</strong>
        <small>{compact(prompt.cachedInputTokens)} cached</small>
      </div>
      <div className="prompt-metric">
        <span>API equivalent</span>
        <strong>
          {prompt.estimatedApiCostUsd === null ? 'Unknown' : `$${prompt.estimatedApiCostUsd.toFixed(3)}`}
        </strong>
      </div>
    </article>
  );
}

function ExpandedThread({ thread }: { thread: ThreadSummary }) {
  const totalPromptMs = thread.prompts.reduce((sum, prompt) => sum + (prompt.durationMs ?? 0), 0);
  const averageTtft = average(thread.prompts.map((prompt) => prompt.timeToFirstTokenMs));
  const tokensPerMinute = totalPromptMs > 0 ? thread.totalTokens / (totalPromptMs / 60_000) : null;
  const cacheHit = thread.inputTokens > 0
    ? (thread.cachedInputTokens / thread.inputTokens) * 100
    : 0;

  return (
    <div className="thread-detail">
      <div className="thread-detail-stats">
        <div>
          <MessageSquareText size={15} />
          <span>Prompts</span>
          <strong>{thread.prompts.length}</strong>
        </div>
        <div>
          <Clock3 size={15} />
          <span>Measured active span</span>
          <strong>{formatDuration(totalPromptMs || null)}</strong>
        </div>
        <div>
          <Zap size={15} />
          <span>Average first token</span>
          <strong>{formatDuration(averageTtft)}</strong>
        </div>
        <div>
          <Gauge size={15} />
          <span>Tokens per minute</span>
          <strong>{tokensPerMinute === null ? '—' : compact(tokensPerMinute)}</strong>
        </div>
        <div>
          <TimerReset size={15} />
          <span>Input cache hit</span>
          <strong>{cacheHit.toFixed(1)}%</strong>
        </div>
        <div>
          <ShieldCheck size={15} />
          <span>Review overhead</span>
          <strong>{compact(thread.reviewerTokens)}</strong>
        </div>
      </div>

      <div className="thread-detail-grid">
        <TokenDistribution
          input={thread.inputTokens}
          cached={thread.cachedInputTokens}
          output={thread.outputTokens}
        />
        <div className="usage-detail-card">
          <div>
            <span>Estimated 5-hour usage</span>
            <strong>{formatUsage(thread.estimatedFiveHourUsagePercent)}</strong>
          </div>
          <div>
            <span>Estimated 7-day usage</span>
            <strong>{formatUsage(thread.estimatedSevenDayUsagePercent)}</strong>
          </div>
          <div>
            <span>Attribution samples</span>
            <strong>{thread.usageSampleIntervals}</strong>
          </div>
          <div>
            <span>Session files combined</span>
            <strong>{thread.partCount}</strong>
          </div>
          <p>
            Quota percentages are estimates based on quota movement and local token events during the same intervals.
          </p>
        </div>
      </div>

      <div className="prompt-section">
        <div className="prompt-section-heading">
          <div>
            <span>Prompt activity</span>
            <strong>Timing and token use for each user prompt or steering message</strong>
          </div>
        </div>
        {thread.prompts.length === 0 ? (
          <div className="prompt-empty">Prompt-level events were not available in this rollout.</div>
        ) : (
          <div className="prompt-list">
            {thread.prompts.map((prompt) => <PromptRow key={prompt.promptId} prompt={prompt} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadsTable({ threads }: { threads: ThreadSummary[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (threadId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  };

  return (
    <section className="panel threads-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Local history</p>
          <h2>Threads</h2>
          <p className="panel-subtitle">
            Expand a thread for token distribution, estimated quota use, and prompt-level timing.
          </p>
        </div>
      </div>
      {threads.length === 0 ? (
        <div className="table-empty">No thread usage has been indexed.</div>
      ) : (
        <div className="table-scroll">
          <table className="threads-table">
            <thead>
              <tr>
                <th aria-label="Expand thread" />
                <th>Thread</th>
                <th>Model</th>
                <th>Estimated usage</th>
                <th>Tokens</th>
                <th>API equivalent</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {threads.map((thread) => {
                const isExpanded = expanded.has(thread.threadId);
                return (
                  <Fragment key={thread.threadId}>
                    <tr className={isExpanded ? 'thread-summary-row expanded' : 'thread-summary-row'}>
                      <td className="expand-cell">
                        <button
                          className="expand-button"
                          type="button"
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${thread.title}`}
                          onClick={() => toggle(thread.threadId)}
                        >
                          {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                      <td>
                        <button className="thread-title-button" type="button" onClick={() => toggle(thread.threadId)}>
                          <span className="thread-title" title={thread.title}>{thread.title}</span>
                        </button>
                        <div className="thread-path" title={thread.projectPath ?? undefined}>
                          <FolderOpen size={12} />
                          {thread.projectPath ?? 'Project path unavailable'}
                        </div>
                        {thread.userMessageCount > 1 && (
                          <span className="muted-inline">
                            <MessageSquareText size={12} /> {thread.userMessageCount} prompts in thread
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="model-label">{thread.primaryModel}</span>
                        {thread.reviewerTokens > 0 && (
                          <span className="muted-inline">
                            <ShieldCheck size={12} /> auto-review included
                          </span>
                        )}
                      </td>
                      <td className="numeric-cell">
                        {formatUsage(thread.estimatedSevenDayUsagePercent)}
                        <span className="sub-value">7-day window</span>
                        {thread.estimatedFiveHourUsagePercent !== null && (
                          <span className="sub-value">{formatUsage(thread.estimatedFiveHourUsagePercent)} in 5-hour</span>
                        )}
                      </td>
                      <td className="numeric-cell">
                        {compact(thread.totalTokens)}
                        <span className="sub-value">
                          {compact(thread.inputTokens)} in · {compact(thread.outputTokens)} out
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
                    {isExpanded && (
                      <tr className="thread-expanded-row">
                        <td colSpan={7}><ExpandedThread thread={thread} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
