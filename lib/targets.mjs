function normalizedPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  if (value === '/') return '/';
  return value.replace(/\/+$/, '') || '/';
}

export function pathPrefixMatches(path, prefix) {
  const normalizedPathValue = normalizedPath(path);
  const normalizedPrefix = normalizedPath(prefix);
  if (!normalizedPathValue || !normalizedPrefix) return false;
  if (normalizedPrefix === '/') return true;
  return normalizedPathValue === normalizedPrefix || normalizedPathValue.startsWith(`${normalizedPrefix}/`);
}

export function targetMatchesAllowlist(target, allowedTargets = []) {
  if (!target?.host || !target?.path) return false;
  return allowedTargets.some(allowed => allowed?.host?.toLowerCase() === target.host.toLowerCase() &&
    pathPrefixMatches(target.path, allowed.pathPrefix));
}
