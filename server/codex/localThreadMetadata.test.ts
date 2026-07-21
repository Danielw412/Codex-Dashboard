import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readLocalThreadMetadata } from './localThreadMetadata.js';

test('reads generated Codex chat titles from state_5.sqlite', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dashboard-title-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  const database = new DatabaseSync(path.join(directory, 'state_5.sqlite'));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      updated_at_ms INTEGER
    );
    INSERT INTO threads (id, title, preview, updated_at_ms)
    VALUES ('thread-1', 'Fix mobile UX and auth flows', 'make these changes to the UI/UX', 1784600000000);
  `);
  database.close();

  try {
    assert.deepEqual(readLocalThreadMetadata(), [{
      threadId: 'thread-1',
      displayName: 'Fix mobile UX and auth flows',
      preview: 'make these changes to the UI/UX',
      updatedAt: 1784600000
    }]);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
