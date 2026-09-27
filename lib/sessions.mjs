import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDirectory } from './journal.mjs';

function sessionKey(chatId) {
  return createHash('sha256').update(String(chatId)).digest('hex');
}

export function sessionPath(dataDir, chatId) {
  return join(ensurePrivateDirectory(join(dataDir, 'sessions')), `${sessionKey(chatId)}.json`);
}

export function loadSession(dataDir, chatId) {
  const path = sessionPath(dataDir, chatId);
  if (!existsSync(path)) return null;
  const session = JSON.parse(readFileSync(path, 'utf8'));
  if (session.chatId !== chatId) throw new Error('Local session key did not match the requested chat ID.');
  return session;
}

export function saveSession(dataDir, session) {
  const path = sessionPath(dataDir, session.chatId);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
  return path;
}

export function acquireSessionLock(dataDir, chatId) {
  const directory = ensurePrivateDirectory(join(dataDir, 'locks'));
  const lockPath = join(directory, `${sessionKey(chatId)}.lock`);
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify({ chatId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    try { chmodSync(lockPath, 0o600); } catch {}
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another local process owns this chat session lock; refusing concurrent writes.');
    throw new Error(`Cannot protect chat-session ownership locally: ${error.message}`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { closeSync(fd); } catch {}
    try { unlinkSync(lockPath); } catch {}
  };
}
