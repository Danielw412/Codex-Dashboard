import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DailyUsage,
  ModelEfficiency,
  ModelUsageSummary,
  PricingStatus,
  PromptMetric,
  RateLimitWindow,
  SessionPartKind,
  ThreadPartSummary,
  ThreadSummary,
  TitleSource,
  TokenUsage
} from './types.js';

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

  CREATE TABLE IF NOT EXISTS session_parts (
    source_file TEXT PRIMARY KEY,
    modified_ms REAL NOT NULL,
    size_bytes INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    part_kind TEXT NOT NULL,
    title TEXT,
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
    pricing_status TEXT NOT NULL,
    user_message_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_session_parts_thread
    ON session_parts(thread_id, part_kind, updated_at);

  CREATE TABLE IF NOT EXISTS session_part_token_events (
    event_key TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    FOREIGN KEY(source_file) REFERENCES session_parts(source_file) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_session_part_events_time
    ON session_part_token_events(observed_at);
  CREATE INDEX IF NOT EXISTS idx_session_part_events_thread
    ON session_part_token_events(thread_id, observed_at);

  CREATE TABLE IF NOT EXISTS prompt_metrics (
    prompt_id TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    sequence_number INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER,
    time_to_first_token_ms INTEGER,
    timing_estimated INTEGER NOT NULL,
    primary_model TEXT NOT NULL,
    models_json TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL,
    pricing_status TEXT NOT NULL,
    FOREIGN KEY(source_file) REFERENCES session_parts(source_file) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_metrics_thread
    ON prompt_metrics(thread_id, started_at);

  CREATE TABLE IF NOT EXISTS thread_metadata (
    thread_id TEXT PRIMARY KEY,
    display_name TEXT,
    preview TEXT,
    updated_at INTEGER NOT NULL
  );
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
  sourceFile: string;
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
    FROM session_parts WHERE source_file = ?
  `).get(sourceFile);
  return (result as { modifiedMs: number; sizeBytes: number; threadId: string } | undefined) ?? null;
}

export function replaceThreadData(
  summary: ThreadPartSummary,
  events: StoredThreadEvent[],
  prompts: PromptMetric[],
  fileState: { modifiedMs: number; sizeBytes: number }
): void {
  const upsertPart = db.prepare(`
    INSERT INTO session_parts (
      source_file, modified_ms, size_bytes, thread_id, part_kind, title,
      project_path, started_at, updated_at, primary_model, models_json,
      input_tokens, cached_input_tokens, output_tokens,
      reasoning_output_tokens, total_tokens, estimated_cost_usd,
      pricing_status, user_message_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_file) DO UPDATE SET
      modified_ms = excluded.modified_ms,
      size_bytes = excluded.size_bytes,
      thread_id = excluded.thread_id,
      part_kind = excluded.part_kind,
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
      pricing_status = excluded.pricing_status,
      user_message_count = excluded.user_message_count
  `);
  const insertEvent = db.prepare(`
    INSERT INTO session_part_token_events (
      event_key, source_file, thread_id, observed_at, model, input_tokens,
      cached_input_tokens, output_tokens, reasoning_output_tokens,
      total_tokens, estimated_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPrompt = db.prepare(`
    INSERT INTO prompt_metrics (
      prompt_id, source_file, thread_id, turn_id, sequence_number, prompt_text,
      started_at, completed_at, duration_ms, time_to_first_token_ms,
      timing_estimated, primary_model, models_json, input_tokens,
      cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
      estimated_cost_usd, pricing_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE;');
  try {
    upsertPart.run(
      summary.sourceFile,
      fileState.modifiedMs,
      fileState.sizeBytes,
      summary.threadId,
      summary.partKind,
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
      summary.pricingStatus,
      summary.userMessageCount
    );
    db.prepare('DELETE FROM session_part_token_events WHERE source_file = ?').run(summary.sourceFile);
    db.prepare('DELETE FROM prompt_metrics WHERE source_file = ?').run(summary.sourceFile);
    for (const event of events) {
      insertEvent.run(
        event.eventKey,
        event.sourceFile,
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
    for (const prompt of prompts) {
      insertPrompt.run(
        prompt.promptId,
        prompt.sourceFile,
        prompt.threadId,
        prompt.turnId,
        prompt.sequence,
        prompt.prompt,
        prompt.startedAt,
        prompt.completedAt,
        prompt.durationMs,
        prompt.timeToFirstTokenMs,
        prompt.timingEstimated ? 1 : 0,
        prompt.primaryModel,
        JSON.stringify(prompt.models),
        prompt.inputTokens,
        prompt.cachedInputTokens,
        prompt.outputTokens,
        prompt.reasoningOutputTokens,
        prompt.totalTokens,
        prompt.estimatedApiCostUsd,
        prompt.pricingStatus
      );
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export function upsertThreadMetadata(items: Array<{
  threadId: string;
  displayName: string | null;
  preview: string | null;
  updatedAt: number;
}>): void {
  const statement = db.prepare(`
    INSERT INTO thread_metadata (thread_id, display_name, preview, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, thread_metadata.display_name),
      preview = COALESCE(excluded.preview, thread_metadata.preview),
      updated_at = MAX(excluded.updated_at, thread_metadata.updated_at)
  `);
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const item of items) {
      statement.run(item.threadId, item.displayName, item.preview, item.updatedAt);
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

interface PartRow extends TokenUsage {
  sourceFile: string;
  threadId: string;
  partKind: SessionPartKind;
  title: string | null;
  projectPath: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  primaryModel: string;
  modelsJson: string;
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
  userMessageCount: number;
}

interface ModelTokenRow {
  threadId: string;
  model: string;
  totalTokens: number;
}

interface MetadataRow {
  threadId: string;
  displayName: string | null;
  preview: string | null;
}

interface PromptRow extends TokenUsage {
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
  timingEstimated: number;
  primaryModel: string;
  modelsJson: string;
  estimatedApiCostUsd: number | null;
  pricingStatus: PricingStatus;
}

function getPromptMap(): Map<string, PromptMetric[]> {
  const promptRows = rows<PromptRow>(db.prepare(`
    SELECT prompt_id AS promptId, source_file AS sourceFile, thread_id AS threadId,
           turn_id AS turnId, sequence_number AS sequence, prompt_text AS prompt,
           started_at AS startedAt, completed_at AS completedAt,
           duration_ms AS durationMs, time_to_first_token_ms AS timeToFirstTokenMs,
           timing_estimated AS timingEstimated, primary_model AS primaryModel,
           models_json AS modelsJson, input_tokens AS inputTokens,
           cached_input_tokens AS cachedInputTokens, output_tokens AS outputTokens,
           reasoning_output_tokens AS reasoningOutputTokens, total_tokens AS totalTokens,
           estimated_cost_usd AS estimatedApiCostUsd, pricing_status AS pricingStatus
    FROM prompt_metrics
    ORDER BY started_at ASC, sequence_number ASC
  `).all());
  const map = new Map<string, PromptMetric[]>();
  for (const row of promptRows) {
    const item: PromptMetric = {
      ...row,
      timingEstimated: Boolean(row.timingEstimated),
      models: JSON.parse(row.modelsJson) as string[]
    };
    const list = map.get(row.threadId) ?? [];
    list.push(item);
    map.set(row.threadId, list);
  }
  return map;
}

function buildThreadSummaries(): ThreadSummary[] {
  const parts = rows<PartRow>(db.prepare(`
    SELECT source_file AS sourceFile, thread_id AS threadId, part_kind AS partKind,
           title, project_path AS projectPath, started_at AS startedAt,
           updated_at AS updatedAt, primary_model AS primaryModel,
           models_json AS modelsJson, input_tokens AS inputTokens,
           cached_input_tokens AS cachedInputTokens, output_tokens AS outputTokens,
           reasoning_output_tokens AS reasoningOutputTokens,
           total_tokens AS totalTokens, estimated_cost_usd AS estimatedApiCostUsd,
           pricing_status AS pricingStatus, user_message_count AS userMessageCount
    FROM session_parts
    ORDER BY COALESCE(started_at, updated_at, 0) ASC
  `).all());

  const metadata = new Map(
    rows<MetadataRow>(db.prepare(`
      SELECT thread_id AS threadId, display_name AS displayName, preview
      FROM thread_metadata
    `).all()).map((row) => [row.threadId, row])
  );
  const promptMap = getPromptMap();

  const mainModelTokens = rows<ModelTokenRow>(db.prepare(`
    SELECT e.thread_id AS threadId, e.model, SUM(e.total_tokens) AS totalTokens
    FROM session_part_token_events e
    JOIN session_parts p ON p.source_file = e.source_file
    WHERE p.part_kind = 'main' AND lower(e.model) <> 'codex-auto-review'
    GROUP BY e.thread_id, e.model
  `).all());
  const modelWeights = new Map<string, Map<string, number>>();
  for (const row of mainModelTokens) {
    const weights = modelWeights.get(row.threadId) ?? new Map<string, number>();
    weights.set(row.model, row.totalTokens);
    modelWeights.set(row.threadId, weights);
  }

  const grouped = new Map<string, ThreadSummary & { hasPriced: boolean; hasUnpriced: boolean }>();
  for (const part of parts) {
    const partModels = JSON.parse(part.modelsJson) as string[];
    let thread = grouped.get(part.threadId);
    if (!thread) {
      thread = {
        threadId: part.threadId,
        title: part.partKind === 'main' && part.title ? part.title : 'Untitled Codex thread',
        titleSource: part.partKind === 'main' && part.title ? 'prompt' : 'fallback',
        projectPath: part.partKind === 'main' ? part.projectPath : null,
        startedAt: part.startedAt,
        updatedAt: part.updatedAt,
        primaryModel: part.partKind === 'main' ? part.primaryModel : 'unknown',
        models: [],
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        estimatedApiCostUsd: null,
        pricingStatus: 'unknown',
        sourceFile: part.sourceFile,
        userMessageCount: 0,
        reviewerTokens: 0,
        partCount: 0,
        prompts: [],
        estimatedFiveHourUsagePercent: null,
        estimatedSevenDayUsagePercent: null,
        usageSampleIntervals: 0,
        hasPriced: false,
        hasUnpriced: false
      };
      grouped.set(part.threadId, thread);
    }

    if (part.partKind === 'main') {
      if (thread.titleSource === 'fallback' && part.title) {
        thread.title = part.title;
        thread.titleSource = 'prompt';
      }
      if (!thread.projectPath && part.projectPath) thread.projectPath = part.projectPath;
      if (thread.primaryModel === 'unknown' && part.primaryModel !== 'unknown') {
        thread.primaryModel = part.primaryModel;
      }
      thread.sourceFile = part.sourceFile;
      thread.userMessageCount += part.userMessageCount;
    }

    thread.startedAt = thread.startedAt === null
      ? part.startedAt
      : part.startedAt === null
        ? thread.startedAt
        : Math.min(thread.startedAt, part.startedAt);
    thread.updatedAt = thread.updatedAt === null
      ? part.updatedAt
      : part.updatedAt === null
        ? thread.updatedAt
        : Math.max(thread.updatedAt, part.updatedAt);
    thread.inputTokens += part.inputTokens;
    thread.cachedInputTokens += part.cachedInputTokens;
    thread.outputTokens += part.outputTokens;
    thread.reasoningOutputTokens += part.reasoningOutputTokens;
    thread.totalTokens += part.totalTokens;
    if (part.partKind === 'reviewer') thread.reviewerTokens += part.totalTokens;
    thread.partCount += 1;
    for (const model of partModels) if (!thread.models.includes(model)) thread.models.push(model);
    if (part.estimatedApiCostUsd !== null) {
      thread.estimatedApiCostUsd = (thread.estimatedApiCostUsd ?? 0) + part.estimatedApiCostUsd;
      thread.hasPriced = true;
    }
    if (part.pricingStatus !== 'exact-model-match') thread.hasUnpriced = true;
  }

  for (const thread of grouped.values()) {
    const weights = modelWeights.get(thread.threadId);
    const weightedPrimary = weights
      ? [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      : null;
    if (weightedPrimary) thread.primaryModel = weightedPrimary;
    if (thread.primaryModel === 'codex-auto-review') thread.primaryModel = 'unknown';
    thread.pricingStatus = !thread.hasPriced
      ? 'unknown'
      : thread.hasUnpriced
        ? 'partial'
        : 'exact-model-match';
    thread.prompts = promptMap.get(thread.threadId) ?? [];

    const storedMetadata = metadata.get(thread.threadId);
    if (storedMetadata?.displayName) {
      thread.title = storedMetadata.displayName;
      thread.titleSource = 'codex-name';
    } else if (storedMetadata?.preview) {
      thread.title = storedMetadata.preview;
      thread.titleSource = 'codex-preview';
    }
  }

  return [...grouped.values()]
    .map(({ hasPriced: _hasPriced, hasUnpriced: _hasUnpriced, ...thread }) => thread)
    .sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
}

export function getThreadSummaries(limit = 100): ThreadSummary[] {
  return buildThreadSummaries().slice(0, limit);
}

type TokenTotals = TokenUsage & {
  threads: number;
  estimatedApiCostUsd: number;
  pricedThreads: number;
  unknownPriceThreads: number;
};

export function getTokenTotals(): TokenTotals {
  const summaries = buildThreadSummaries();
  return summaries.reduce<TokenTotals>(
    (total, thread) => {
      total.threads += 1;
      total.inputTokens += thread.inputTokens;
      total.cachedInputTokens += thread.cachedInputTokens;
      total.outputTokens += thread.outputTokens;
      total.reasoningOutputTokens += thread.reasoningOutputTokens;
      total.totalTokens += thread.totalTokens;
      total.estimatedApiCostUsd += thread.estimatedApiCostUsd ?? 0;
      if (thread.estimatedApiCostUsd !== null) total.pricedThreads += 1;
      if (thread.pricingStatus !== 'exact-model-match') total.unknownPriceThreads += 1;
      return total;
    },
    {
      threads: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedApiCostUsd: 0,
      pricedThreads: 0,
      unknownPriceThreads: 0
    }
  );
}

export function getLocalDailyUsage(days = 7): DailyUsage[] {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const result = db.prepare(`
    SELECT date(observed_at, 'unixepoch', 'localtime') AS date,
           SUM(total_tokens) AS tokens,
           'local' AS source
    FROM session_part_token_events
    WHERE observed_at >= ?
    GROUP BY date(observed_at, 'unixepoch', 'localtime')
    ORDER BY date ASC
  `).all(since);
  return rows<DailyUsage>(result);
}

export function getThreadTokenEvents(since: number): Array<{
  observedAt: number;
  threadId: string;
  totalTokens: number;
  estimatedApiCostUsd: number;
}> {
  return rows<{
    observedAt: number;
    threadId: string;
    totalTokens: number;
    estimatedApiCostUsd: number;
  }>(db.prepare(`
    SELECT observed_at AS observedAt, thread_id AS threadId,
           total_tokens AS totalTokens, COALESCE(estimated_cost_usd, 0) AS estimatedApiCostUsd
    FROM session_part_token_events
    WHERE observed_at >= ?
    ORDER BY observed_at ASC
  `).all(since));
}

export function getModelTokenEvents(since: number): Array<{
  observedAt: number;
  model: string;
  totalTokens: number;
  estimatedApiCostUsd: number;
}> {
  const primaryModels = new Map(buildThreadSummaries().map((thread) => [thread.threadId, thread.primaryModel]));
  const result = rows<{
    observedAt: number;
    threadId: string;
    partKind: SessionPartKind;
    model: string;
    totalTokens: number;
    estimatedApiCostUsd: number;
  }>(db.prepare(`
    SELECT e.observed_at AS observedAt, e.thread_id AS threadId,
           p.part_kind AS partKind, e.model, e.total_tokens AS totalTokens,
           COALESCE(e.estimated_cost_usd, 0) AS estimatedApiCostUsd
    FROM session_part_token_events e
    JOIN session_parts p ON p.source_file = e.source_file
    WHERE e.observed_at >= ?
    ORDER BY e.observed_at ASC
  `).all(since));

  return result.map((event) => ({
    observedAt: event.observedAt,
    model: event.partKind === 'reviewer' || event.model === 'codex-auto-review'
      ? primaryModels.get(event.threadId) ?? event.model
      : event.model,
    totalTokens: event.totalTokens,
    estimatedApiCostUsd: event.estimatedApiCostUsd
  }));
}

export function getModelUsageSummaries(): ModelUsageSummary[] {
  const result = rows<{
    model: string;
    threads: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    estimatedApiCostUsd: number;
    pricedEvents: number;
    eventCount: number;
  }>(db.prepare(`
    SELECT model,
           COUNT(DISTINCT thread_id) AS threads,
           SUM(input_tokens) AS inputTokens,
           SUM(cached_input_tokens) AS cachedInputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(reasoning_output_tokens) AS reasoningOutputTokens,
           SUM(total_tokens) AS totalTokens,
           COALESCE(SUM(estimated_cost_usd), 0) AS estimatedApiCostUsd,
           SUM(CASE WHEN estimated_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS pricedEvents,
           COUNT(*) AS eventCount
    FROM session_part_token_events
    GROUP BY model
    ORDER BY totalTokens DESC
  `).all());

  return result.map(({ pricedEvents, eventCount, ...row }) => ({
    ...row,
    pricingStatus: pricedEvents === 0
      ? 'unknown'
      : pricedEvents < eventCount
        ? 'partial'
        : 'exact-model-match'
  }));
}

export function emptyModelEfficiency(): ModelEfficiency[] {
  return [];
}
