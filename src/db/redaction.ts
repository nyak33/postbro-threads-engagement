const SENSITIVE_KEY_PATTERN = /(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|private[_-]?key|authorization|cookie|set-cookie|api[_-]?key|credential|client[_-]?secret)/i;
const MAX_TEXT_LENGTH = 500;
const MAX_DEPTH = 10;

function redactSensitiveText(value: string): string {
  let output = value.slice(0, MAX_TEXT_LENGTH);

  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  output = output.replace(/\b(sb_secret|ghp|github_pat)_[A-Za-z0-9._-]+/gi, '$1_[REDACTED]');
  output = output.replace(
    /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|api[_-]?key|client[_-]?secret)\b\s*[:=]?\s*[A-Za-z0-9._~+/=-]{6,}/gi,
    '$1 [REDACTED]',
  );

  return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[TRUNCATED]';
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactJson(entry, depth + 1));
  }

  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactJson(entry, depth + 1);
    }
    return output;
  }

  return value;
}

export function redactProviderMetadata(value: unknown): Record<string, unknown> {
  const redacted = redactJson(value);
  return isPlainObject(redacted) ? redacted : { value: redacted };
}

export function redactErrorMessage(value: string): string {
  return redactSensitiveText(value);
}
