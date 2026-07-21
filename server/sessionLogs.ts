import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  getSessionFileState,
  replaceThreadData,
  type StoredThreadEvent
} from './db.js';
import { estimateUsageCost, findPricing } from './pricing.js';
import type { SessionPartKind, ThreadPartSummary, TokenUsage } from './types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.round(parsed));
  }
  return 0;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return null;
}

function usageFrom(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = toNumber(value.input_tokens ?? value.inputTokens);
  const cachedInputTokens = toNumber(value.cached_input_tokens ?? value.cachedInputTokens);
  const outputTokens = toNumber(value.output_tokens ?? value.outputTokens);
  const reasoningOutputTokens = toNumber(
    value.reasoning_output_tokens ?? value.reasoningOutputTokens
  );
  const totalTokens = toNumber(value.total_tokens ?? value.totalTokens) || inputTokens + outputTokens;
  if (inputTokens + outputTokens + totalTokens === 0) return null;
  return {
    inputTokens,
    cachedInputTokens: Math.min(cachedInputTokens, inputTokens),
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function findIncrementalUsage(record: JsonRecord): TokenUsage | null {
  const payload = isRecord(record.payload) ? record.payload : record;
  const info = isRecord(payload.info) ? payload.info : null;
  const direct = info?.last_token_usage ?? info?.lastTokenUsage ?? payload.last_token_usage;
  const parsed = usageFrom(direct);
  if (parsed) return parsed;

  if (payload.type === 'raw_response_completed' || payload.type === 'rawResponse/completed') {
    return usageFrom(payload.usage);
  }
  return null;
}

function eventType(record: JsonRecord): string {
  const payload = isRecord(record.payload) ? record.payload : null;
  const innerPayload = payload && isRecord(payload.payload) ? payload.payload : null;
  const values = [innerPayload?.type, payload?.type, record.type];
  return values.find((value): value is string => typeof value === 'string') ?? '';
}

function recordTimestamp(record: JsonRecord): number | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  return parseTimestamp(record.timestamp ?? payload?.timestamp ?? payload?.created_at);
}

function findString(record: JsonRecord, keys: string[]): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  const innerPayload = payload && isRecord(payload.payload) ? payload.payload : null;
  for (const container of [innerPayload, payload, record]) {
    if (!container) continue;
    for (const key of keys) {
      const value = container[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return null;
}

function extractModel(record: JsonRecord): string | null {
  const type = eventType(record).toLowerCase();
  if (
    !type.includes('context') &&
    !type.includes('turn') &&
    !type.includes('session') &&
    !type.includes('model') &&
    !type.includes('response')
  ) {
    return null;
  }
  return findString(record, ['model', 'model_name', 'modelName', 'model_slug', 'modelSlug']);
}

function extractThreadId(record: JsonRecord): string | null {
  const type = eventType(record).toLowerCase();
  if (!type.includes('session') && !type.includes('metadata') && !type.includes('thread')) {
    return null;
  }
  return findString(record, ['thread_id', 'threadId', 'session_id', 'sessionId', 'id']);
}

function extractProjectPath(record: JsonRecord): string | null {
  const type = eventType(record).toLowerCase();
  if (!type.includes('session') && !type.includes('context') && !type.includes('turn')) {
    return null;
  }
  return findString(record, ['cwd', 'working_directory', 'workingDirectory', 'project_path']);
}

function detectPartKind(record: JsonRecord): SessionPartKind | null {
  if (String(record.type).toLowerCase() !== 'session_meta') return null;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;

  const threadSource = typeof payload.thread_source === 'string' ? payload.thread_source.toLowerCase() : '';
  const source = payload.source;
  const sourceText = JSON.stringify(source ?? '').toLowerCase();
  if (sourceText.includes('guardian') || sourceText.includes('review')) return 'reviewer';
  if (threadSource === 'subagent' || (isRecord(source) && isRecord(source.subagent))) return 'subagent';
  return 'main';
}

function extractRawUserMessage(record: JsonRecord): string | null {
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;

  // event_msg/user_message is the canonical user-authored entry. Response-item
  // messages can also contain injected app/plugin context that is not a real prompt.
  if (record.type === 'event_msg' && payload.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : null;
  }
  return null;
}

function cleanUserMessage(message: string): string | null {
  let text = message.replace(/\r\n/g, '\n').trim();
  const requestMarker = /##\s*My request for Codex:\s*/i.exec(text);
  if (requestMarker) text = text.slice(requestMarker.index + requestMarker[0].length).trim();

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (
    /^the following is the codex agent history/i.test(normalized) ||
    /^the following is the codex agent transcript/i.test(normalized) ||
    /^continue the same review conversation/i.test(normalized)
  ) {
    return null;
  }

  return normalized.slice(0, 120);
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
}

function defaultUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  if (!fs.existsSync(root)) return result;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
    }
  }
  return result;
}

interface ParsedSession {
  summary: ThreadPartSummary;
  events: StoredThreadEvent[];
}

async function parseSessionFile(sourceFile: string): Promise<ParsedSession | null> {
  const stream = fs.createReadStream(sourceFile, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let threadId: string | null = null;
  let title: string | null = null;
  let projectPath: string | null = null;
  let currentModel = 'unknown';
  let partKind: SessionPartKind = 'main';
  let startedAt: number | null = null;
  let updatedAt: number | null = null;
  let lineNumber = 0;
  let userMessageCount = 0;
  const seenUserMessages = new Set<string>();
  const events: StoredThreadEvent[] = [];
  const totals = defaultUsage();
  const modelTokens = new Map<string, number>();
  const models = new Set<string>();
  let totalCost = 0;
  let pricedEvents = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let record: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }

    const timestamp = recordTimestamp(record);
    if (timestamp !== null) {
      startedAt = startedAt === null ? timestamp : Math.min(startedAt, timestamp);
      updatedAt = updatedAt === null ? timestamp : Math.max(updatedAt, timestamp);
    }

    threadId ??= extractThreadId(record);
    projectPath ??= extractProjectPath(record);
    partKind = detectPartKind(record) ?? partKind;

    const rawUserMessage = extractRawUserMessage(record);
    if (rawUserMessage) {
      const dedupeKey = rawUserMessage.replace(/\s+/g, ' ').trim();
      if (!seenUserMessages.has(dedupeKey)) {
        seenUserMessages.add(dedupeKey);
        const cleaned = cleanUserMessage(rawUserMessage);
        if (cleaned) {
          userMessageCount += 1;
          title ??= cleaned;
        }
      }
    }

    const model = extractModel(record);
    if (model) {
      currentModel = model;
      if (model.toLowerCase() === 'codex-auto-review') partKind = 'reviewer';
    }

    const usage = findIncrementalUsage(record);
    if (!usage) continue;

    const observedAt = timestamp ?? updatedAt ?? Math.floor(Date.now() / 1000);
    const cost = estimateUsageCost(currentModel, usage);
    const eventKey = crypto
      .createHash('sha1')
      .update(`${sourceFile}:${lineNumber}:${observedAt}`)
      .digest('hex');
    events.push({
      eventKey,
      threadId: '',
      sourceFile,
      observedAt,
      model: currentModel,
      ...usage,
      estimatedApiCostUsd: cost
    });
    addUsage(totals, usage);
    models.add(currentModel);
    modelTokens.set(currentModel, (modelTokens.get(currentModel) ?? 0) + usage.totalTokens);
    if (cost !== null) {
      totalCost += cost;
      pricedEvents += 1;
    }
  }

  if (events.length === 0) return null;
  const fallbackId = crypto.createHash('sha1').update(sourceFile).digest('hex');
  const finalThreadId = threadId ?? fallbackId;
  for (const event of events) event.threadId = finalThreadId;

  const primaryModel =
    [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? currentModel;
  const unknownModels = [...models].filter((model) => findPricing(model) === null);
  const pricingStatus: ThreadPartSummary['pricingStatus'] =
    pricedEvents === 0 ? 'unknown' : unknownModels.length > 0 ? 'partial' : 'exact-model-match';

  return {
    summary: {
      threadId: finalThreadId,
      title: partKind === 'main' ? title : null,
      projectPath,
      startedAt,
      updatedAt,
      primaryModel,
      models: [...models],
      ...totals,
      estimatedApiCostUsd: pricedEvents > 0 ? totalCost : null,
      pricingStatus,
      sourceFile,
      partKind,
      userMessageCount: partKind === 'main' ? userMessageCount : 0
    },
    events
  };
}

export async function scanCodexSessions(): Promise<{
  scanned: number;
  updated: number;
  errors: number;
}> {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const roots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  const files = (await Promise.all(roots.map(listJsonlFiles))).flat();
  let updated = 0;
  let errors = 0;

  for (const sourceFile of files) {
    try {
      const stat = await fs.promises.stat(sourceFile);
      const previous = getSessionFileState(sourceFile);
      if (previous && previous.modifiedMs === stat.mtimeMs && previous.sizeBytes === stat.size) {
        continue;
      }
      const parsed = await parseSessionFile(sourceFile);
      if (!parsed) continue;
      replaceThreadData(parsed.summary, parsed.events, {
        modifiedMs: stat.mtimeMs,
        sizeBytes: stat.size
      });
      updated += 1;
    } catch (error) {
      errors += 1;
      console.warn(`Failed to parse Codex session ${sourceFile}:`, error);
    }
  }

  return { scanned: files.length, updated, errors };
}
