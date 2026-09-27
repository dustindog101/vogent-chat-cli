const SECRET_KEY = /secret|token|password|authorization|api[_-]?key|credential/i;
const IDENTIFIER_KEY = /patient|caller|phone(number)?|dateofbirth|\bdob\b|email|first_?name|last_?name|full_?name/i;
const FREE_TEXT_KEY = /^(text|arguments|callAgentInput|input|transcript|message|raw|request|response)$/i;

export function redactForExport(value, key = '') {
  if (SECRET_KEY.test(key) || IDENTIFIER_KEY.test(key) || FREE_TEXT_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redactForExport(item));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactForExport(childValue, childKey);
  }
  return result;
}
