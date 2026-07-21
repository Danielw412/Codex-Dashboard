import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface LocalThreadMetadata {
  threadId: string;
  displayName: string | null;
  preview: string | null;
  updatedAt: number;
}

type SqliteRow = Record<string, unknown>;

function textValue(value: unknown, maxLength = 300): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function timestampSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return Math.round(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function columnExpression(columns: Set<string>, candidates: string[], alias: string): string {
  const column = candidates.find((candidate) => columns.has(candidate));
  return column ? `${column} AS ${alias}` : `NULL AS ${alias}`;
}

export function readLocalThreadMetadata(): LocalThreadMetadata[] {
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const statePath = path.join(codexHome, 'state_5.sqlite');
  if (!fs.existsSync(statePath)) return [];

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(statePath, { readOnly: true });
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
      .get();
    if (!table) return [];

    const columns = new Set(
      (database.prepare('PRAGMA table_info(threads)').all() as SqliteRow[])
        .map((row) => typeof row.name === 'string' ? row.name : null)
        .filter((name): name is string => name !== null)
    );
    if (!columns.has('id') || !columns.has('title')) return [];

    const previewExpression = columnExpression(
      columns,
      ['preview', 'first_user_message', 'firstUserMessage'],
      'preview'
    );
    const updatedExpression = columnExpression(
      columns,
      ['updated_at_ms', 'updated_at', 'recency_at_ms', 'created_at_ms', 'created_at'],
      'updatedAtValue'
    );
    const rows = database.prepare(`
      SELECT id AS threadId, title AS displayName,
             ${previewExpression}, ${updatedExpression}
      FROM threads
      WHERE title IS NOT NULL AND trim(title) <> ''
    `).all() as SqliteRow[];

    return rows.flatMap((row) => {
      const threadId = textValue(row.threadId, 200);
      const displayName = textValue(row.displayName);
      if (!threadId || !displayName) return [];
      return [{
        threadId,
        displayName,
        preview: textValue(row.preview, 500),
        updatedAt: timestampSeconds(row.updatedAtValue)
      }];
    });
  } catch (error) {
    if (process.env.DEBUG_CODEX_DASHBOARD === 'true') {
      console.warn('Could not read Codex desktop thread titles:', (error as Error).message);
    }
    return [];
  } finally {
    database?.close();
  }
}
