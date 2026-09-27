import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const JOURNAL_SCHEMA = 'vogent-run.v1';

export function defaultDataDir(env = process.env) {
  return env.VOGENT_CHAT_HOME || join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'vogent-chat');
}

export function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch {}
  return path;
}

export function createJournal({ dataDir = defaultDataDir(), header = {} } = {}) {
  const runId = randomUUID();
  const directory = ensurePrivateDirectory(join(dataDir, 'runs'));
  const filePath = join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${runId}.jsonl`);
  const fd = openSync(filePath, 'wx', 0o600);
  try { chmodSync(filePath, 0o600); } catch {}
  let finalized = false;
  const append = (type, data = {}) => {
    if (finalized) throw new Error('Run journal is already finalized.');
    const record = {
      schema: JOURNAL_SCHEMA,
      runId,
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
    fsyncSync(fd);
    return record;
  };
  append('run_started', { ...header, runId, createdAt: new Date().toISOString() });
  return {
    runId,
    filePath,
    append,
    finalize(status, details = {}) {
      if (finalized) return;
      append('run_finished', { status, ...details, finishedAt: new Date().toISOString() });
      fsyncSync(fd);
      closeSync(fd);
      finalized = true;
    },
    close() {
      if (finalized) return;
      fsyncSync(fd);
      closeSync(fd);
      finalized = true;
    },
  };
}

export function readJournal(filePath) {
  const source = readFileSync(filePath, 'utf8').trim();
  if (!source) return [];
  return source.split(/\r?\n/).map(line => JSON.parse(line));
}
