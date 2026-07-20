import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DailyUsage, ModelEfficiency, RateLimitWindow, ThreadSummary, TokenUsage } from './types.js';

const dataDir = path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'codex-usage.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at INTEGER NOT NULL,
    limit_key TEXT NOT NULL,
    label TEXT NOT NULL,
    used_percent REAL NOT NULL,
    duration_mins INTEGER NOT NULL,
    resets_at INTEGER NOT NULL,
    UNIQUE(observed_at, limit_key, resets_at)
  );
  CREATE INDEX IF NOT EXISTS idx_rate_history
    ON rate_limit_snapshots(limit_key, resets_at, observed_at);

  CREATE TABLE IF NOT EXISTS account_daily_usage (
    usage_date TEXT PRIMARY KEY,
    tokens INTEGER NOT NULL,
    observed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_files (
    source_file TEXT PRIMARY KEY,
    modified_ms REAL NOT NULL,
    size_bytes INTEGER NOT NULL,
    thread_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS thread_summaries (
    thread_id TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    title TEXT NOT NULL,
    project_path TEXT,
    started_at INTEGER,
    updated_at INTEGER,
    primary_model TEXT NOT NULL,
    models_json TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    pricing_status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS thread_token_events (
    event_key TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    FOREIGN KEY(thread_id) REFERENCES thread_summaries(thread_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_thread_events_time
    ON thread_token_events(observed_at);
`);

function rows<T>(value: unknown): T[] {
  return value as T[];
}

export function insertRateLimitSnapshot(limit: RateLimitWindow): void {
  db.prepare(`
    INSERT OR IGNORE INTO rate_limit_snapshots
      (observed_at, limit_key, label, used_percent, duration_mins, resets_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    limit.observedAt,
    limit.key,
    limit.label,
    limit.usedPercent,
    limit.windowDurationMins,
    limit.resetsAt
  );
}

export function getRateLimitHistory(
  durationMins: number,
  resetAt?: number,
  lookbackDays = 8
): RateLimitWindow[] {
  const minObserved = Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const result = resetAt
    ? db.prepare(`
        SELECT limit_key AS key, label, used_percent AS usedPercent,
               duration_mins AS windowDurationMins, resets_at AS resetsAt,
               observed_at AS observedAt
        FROM rate_limit_snapshots
        WHERE duration_mins = ? AND resets_at = ?
        ORDER BY observed_at ASC
      `).all(durationMins, resetAt)
    : db.prepare(`
        SELECT limit_key AS key, label, used_percent AS usedPercent,
               duration_mins AS windowDurationMins, resets_at AS resetsAt,
               observed_at AS observedAt
        FROM rate_limit_snapshots
        WHERE duration_mins = ? AND observed_at >= ?
        ORDER BY observed_at ASC
      `).all(durationMins, minObserved);
  return rows<RateLimitWindow>(result);
}

export function upsertAccountDailyUsage(items: DailyUsage[]): void {
  const statement = db.prepare(`
    INSERT INTO account_daily_usage (usage_date, tokens, observed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(usage_date) DO UPDATE SET
      tokens = excluded.tokens,
      observed_at = excluded.observed_at
  `);
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const item of items) statement.run(item.date, item.tokens, now);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function getAccountDailyUsage(days = 7): DailyUsage[] {
  const result = db.prepare(`
    SELECT usage_date AS date, tokens, 'account' AS source
    FROM account_daily_usage
    ORDER BY usage_date DESC
    LIMIT ?
  `).all(days);
  return rows<DailyUsage>(result).reverse();
}

export interface StoredThreadEvent extends TokenUsage {
  eventKey: string;
  threadId: string;
  observedAt: number;
  model: string;
  estimatedApiCostUsd: number | null;
}

export function getSessionFileState(sourceFile: string): {
  modifiedMs: number;
  sizeBytes: number;
  threadId: string;
} | null {
  const result = db.prepare(`
    SELECT modified_ms AS modifiedMs, size_bytes AS sizeBytes, thread_id AS threadId
    FROM session_files WHERE source_file = ?
  `).get(sourceFile);
  return (result as { modifiedMs: number; sizeBytes: number; threadId: string } | undefined) ?? null;
}

export function replaceThreadData(
  summary: ThreadSummary,
  events: StoredThreadEvent[],
  fileState: { modifiedMs: number; sizeBytes: number }
): void {
  const upsertSummary = db.prepare(`
    INSERT INTO thread_summaries (
      thread_id, source_file, title, project_path, started_at, updated_at,
      primary_model, models_json, input_tokens, cached_input_tokens,
      output_tokens, reasoning_output_tokens, total_tokens,
      estimated_cost_usd, pricing_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      source_file = excluded.source_file,
      title = excluded.title,
      project_path = excluded.project_path,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      primary_model = excluded.primary_model,
      models_json = excluded.models_json,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      estimated_cost_usd = excluded.estimated_cost_usd,
      pricing_status = excluded.pricing_status
  `);
  const insertEvent = db.prepare(`
    INSERT INTO thread_token_events (
      event_key, thread_id, observed_at, model, input_tokens,
      cached_input_tokens, output_tokens, reasoning_output_tokens,
      total_tokens, estimated_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertFile = db.prepare(`
    INSERT INTO session_files (source_file, modified_ms, size_bytes, thread_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_file) DO UPDATE SET
      modified_ms = excluded.modified_ms,
      size_bytes = excluded.size_bytes,
      thread_id = excluded.thread_id
  `);

  db.exec('BEGIN IMMEDIATE;');
  try {
    upsertSummary.run(
      summary.threadId,
      summary.sourceFile,
      summary.title,
      summary.projectPath,
      summary.startedAt,
      summary.updatedAt,
      summary.primaryModel,
      JSON.stringify(summary.models),
      summary.inputTokens,
      summary.cachedInputTokens,
      summary.outputTokens,
      summary.reasoningOutputTokens,
      summary.totalTokens,
      summary.estimatedApiCostUsd,
      summary.pricingStatus
    );
    db.prepare('DELETE FROM thread_token_events WHERE thread_id = ?').run(summary.threadId);
    for (const event of events) {
      insertEvent.run(
        event.eventKey,
        event.threadId,
        event.observedAt,
        event.model,
        event.inputTokens,
        event.cachedInputTokens,
        event.outputTokens,
        event.reasoningOutputTokens,
        event.totalTokens,
        event.estimatedApiCostUsd
      );
    }
    upsertFile.run(summary.sourceFile, fileState.modifiedMs, fileState.sizeBytes, summary.threadId);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function getThreadSummaries(limit = 100): ThreadSummary[] {
  const result = db.prepare(`
    SELECT thread_id AS threadId, source_file AS sourceFile, title,
           project_path AS projectPath, started_at AS startedAt,
           updated_at AS updatedAt, primary_model AS primaryModel,
           models_json AS modelsJson, input_tokens AS inputTokens,
           cached_input_tokens AS cachedInputTokens,
           output_tokens AS outputTokens,
           reasoning_output_tokens AS reasoningOutputTokens,
           total_tokens AS totalTokens, estimated_cost_usd AS estimatedApiCostUsd,
           pricing_status AS pricingStatus
    FROM thread_summaries
    ORDER BY COALESCE(updated_at, started_at, 0) DESC
    LIMIT ?
  `).all(limit);
  return rows<Omit<ThreadSummary, 'models'> & { modelsJson: string }>(result).map(
    ({ modelsJson, ...row }) => ({ ...row, models: JSON.parse(modelsJson) as string[] })
  );
}

type TokenTotals = TokenUsage & {
  threads: number;
  estimatedApiCostUsd: number;
  pricedThreads: number;
  unknownPriceThreads: number;
};

export function getTokenTotals(): TokenTotals {
  const result = db.prepare(`
    SELECT COUNT(*) AS threads,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningOutputTokens,
           COALESCE(SUM(total_tokens), 0) AS totalTokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimatedApiCostUsd,
           COALESCE(SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS pricedThreads,
           COALESCE(SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unknownPriceThreads
    FROM thread_summaries
  `).get();
  return result as unknown as TokenTotals;
}

export function getLocalDailyUsage(days = 7): DailyUsage[] {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const result = db.prepare(`
    SELECT date(observed_at, 'unixepoch', 'localtime') AS date,
           SUM(total_tokens) AS tokens,
           'local' AS source
    FROM thread_token_events
    WHERE observed_at >= ?
    GROUP BY date(observed_at, 'unixepoch', 'localtime')
    ORDER BY date ASC
  `).all(since);
  return rows<DailyUsage>(result);
}

export function getModelTokenEvents(since: number): Array<{
  observedAt: number;
  model: string;
  totalTokens: number;
  estimatedApiCostUsd: number;
}> {
  const result = db.prepare(`
    SELECT observed_at AS observedAt, model, total_tokens AS totalTokens,
           COALESCE(estimated_cost_usd, 0) AS estimatedApiCostUsd
    FROM thread_token_events
    WHERE observed_at >= ?
    ORDER BY observed_at ASC
  `).all(since);
  return rows<{
    observedAt: number;
    model: string;
    totalTokens: number;
    estimatedApiCostUsd: number;
  }>(result);
}

export function emptyModelEfficiency(): ModelEfficiency[] {
  return [];
}
