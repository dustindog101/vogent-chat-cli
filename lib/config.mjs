import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ensurePrivateDirectory } from './journal.mjs';
import { functionTarget } from './provider.mjs';
import { targetMatchesAllowlist } from './targets.mjs';

const SECRET_KEY = /secret|token|password|authorization|api[_-]?key|credential/i;
const VOLATILE_KEY = /^(createdAt|updatedAt|lastUpdatedAt|created_at|updated_at|lastUpdated|lastSeenAt)$/i;
const SCHEMA_KEYS = new Set(['apiSchema', 'inputSchema', 'outputSchema', 'parameters', 'requestSchema', 'requestBodySchema', 'functionSchema']);
const STRUCTURAL_SCHEMA_KEYS = new Set(['type', 'format', 'method', 'httpMethod', 'required', 'properties', 'items', 'additionalProperties', '$ref', 'nullable', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern']);

export function profileFilePath(dataDir) {
  return join(dataDir, 'profiles.json');
}

export function loadProfiles(dataDir) {
  const path = profileFilePath(dataDir);
  if (!existsSync(path)) return { version: 1, profiles: {} };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version !== 1 || !data.profiles || typeof data.profiles !== 'object') throw new Error(`Invalid profile file: ${path}`);
  return data;
}

export function getProfile(dataDir, name) {
  if (!name) return null;
  const config = loadProfiles(dataDir);
  return config.profiles[name] ? { name, ...config.profiles[name] } : null;
}

export function saveProfile(dataDir, name, profile) {
  if (!name || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('Profile names must use 1-64 letters, numbers, dot, underscore or hyphen.');
  if (!profile.agentId) throw new Error('A profile needs an exact agent ID.');
  const config = loadProfiles(dataDir);
  const entry = {
    agentId: String(profile.agentId),
    allowedTargets: normalizeTargets(profile.allowedTargets || []),
  };
  if (profile.expectedDefaultHash) entry.expectedDefaultHash = String(profile.expectedDefaultHash);
  if (profile.harmlessControl) {
    entry.harmlessControl = {
      functionIds: [...new Set((profile.harmlessControl.functionIds || []).map(String))],
      allowedTargets: normalizeTargets(profile.harmlessControl.allowedTargets || []),
      expectedPromptId: profile.harmlessControl.expectedPromptId ? String(profile.harmlessControl.expectedPromptId) : null,
    };
  }
  config.profiles[name] = entry;
  const path = profileFilePath(dataDir);
  ensurePrivateDirectory(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
  return { name, ...entry };
}

function normalizeTargets(targets) {
  return targets.map(target => ({
    host: String(target.host || '').toLowerCase(),
    pathPrefix: String(target.pathPrefix || '/'),
  })).filter(target => target.host && target.pathPrefix.startsWith('/'));
}

export function targetAllowed(target, allowedTargets = []) {
  return targetMatchesAllowlist(target, allowedTargets);
}

function sanitizeConfig(value, key = '') {
  if (SECRET_KEY.test(key) || VOLATILE_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map(item => sanitizeConfig(item)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (SECRET_KEY.test(childKey) || VOLATILE_KEY.test(childKey)) continue;
    if (SCHEMA_KEYS.has(childKey)) {
      result[childKey] = sanitizeSchema(childValue);
      continue;
    }
    if (childKey.toLowerCase() === 'headers') {
      result.headerNames = Array.isArray(childValue) ? childValue.map(item => item?.name ?? item?.key ?? '[unnamed]').sort() : Object.keys(childValue || {}).sort();
      result.headerValues = 'redacted';
      continue;
    }
    if (childKey === 'apiPath') {
      const target = functionTarget({ type: 'api', apiPath: childValue });
      result.apiTarget = target;
      continue;
    }
    const sanitized = sanitizeConfig(childValue, childKey);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== 'object') return '[REDACTED]';
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) || VOLATILE_KEY.test(key)) continue;
    if (key === 'apiPath') {
      result.apiTarget = functionTarget({ type: 'api', apiPath: child });
    } else if (key.toLowerCase() === 'headers') {
      result.headerNames = Array.isArray(child) ? child.map(item => item?.name ?? item?.key ?? '[unnamed]').sort() : Object.keys(child || {}).sort();
      result.headerValues = 'redacted';
    } else if (STRUCTURAL_SCHEMA_KEYS.has(key)) {
      if (key === 'required' && Array.isArray(child)) result[key] = child.map(String).sort();
      else if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'].includes(key)) result[key] = child;
      else if (['type', 'format', 'method', 'httpMethod'].includes(key) && (typeof child === 'string' || (Array.isArray(child) && child.every(item => typeof item === 'string')))) result[key] = child;
      else if (['nullable', 'additionalProperties'].includes(key) && typeof child === 'boolean') result[key] = child;
      else result[key] = sanitizeSchema(child);
    } else if (key === 'description' || key === 'title') {
      result[key] = '[REDACTED]';
    } else if (key === 'body' || key === 'value' || key === 'default' || key === 'example' || key === 'examples' || key === 'enum' || key === 'const') {
      result[key] = sanitizeSchema(child);
    } else {
      // Preserve nested shape and field names; all leaf literals are discarded.
      result[key] = sanitizeSchema(child);
    }
  }
  return result;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function createConfigSnapshot(inspection) {
  const phoneLinkage = inspection.phoneLinkage ? {
    status: inspection.phoneLinkage.status || 'unknown',
    reason: inspection.phoneLinkage.reason || null,
    evidence: (inspection.phoneLinkage.evidence || []).map(item => ({
      phoneId: item.phoneId ?? item.phoneNumberId ?? null,
      field: item.field ?? null,
      agentId: item.agentId ?? null,
    })),
  } : { status: 'unknown', evidence: [] };
  const snapshot = {
    schema: 'vogent-config-snapshot.v1',
    observedAt: new Date().toISOString(),
    agent: sanitizeConfig(inspection.agent),
    defaultPromptId: inspection.agent?.defaultVersionedPromptId || null,
    prompt: sanitizeConfig(inspection.prompt),
    functions: sanitizeConfig(inspection.functions || []),
    phoneLinkage: sanitizeConfig(phoneLinkage),
    versionPinning: { requestedVersion: null, observedDefaultPromptId: inspection.agent?.defaultVersionedPromptId || null, provenExecutedPromptId: null },
  };
  const hashInput = canonicalize({
    agent: snapshot.agent,
    defaultPromptId: snapshot.defaultPromptId,
    prompt: snapshot.prompt,
    functions: snapshot.functions,
    phoneLinkage: snapshot.phoneLinkage,
  });
  snapshot.configurationHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  return snapshot;
}

export function saveJsonPrivate(path, value) {
  ensurePrivateDirectory(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function diffValues(before, after, pointer = '') {
  if (JSON.stringify(canonicalize(before)) === JSON.stringify(canonicalize(after))) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].sort().flatMap(key => diffValues(before[key], after[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: pointer || '/', before: before === undefined ? { missing: true } : before, after: after === undefined ? { missing: true } : after }];
}

export function diffSnapshots(before, after) {
  return {
    beforeHash: before.configurationHash || null,
    afterHash: after.configurationHash || null,
    changed: before.configurationHash !== after.configurationHash,
    differences: diffValues(
      Object.fromEntries(Object.entries(before).filter(([key]) => !['configurationHash', 'observedAt'].includes(key))),
      Object.fromEntries(Object.entries(after).filter(([key]) => !['configurationHash', 'observedAt'].includes(key))),
    ),
  };
}
