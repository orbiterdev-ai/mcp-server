import { isRecord } from './json.js';

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|bearer|auth)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SENSITIVE_PATH_PATTERN = /(?:auth\.json|credentials|state_\d+\.sqlite|logs?_\d*\.sqlite|\.pem|\.key|\.env)/i;

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = '[redacted]';
      } else if (SENSITIVE_PATH_PATTERN.test(key)) {
        out[key] = '[redacted-path]';
      } else {
        out[key] = redactValue(item);
      }
    }
    return out;
  }
  return value;
}

export function redactString(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, '[redacted]');
  }
  output = output.replace(/(Authorization:\s*)[^\r\n]+/gi, '$1[redacted]');
  output = output.replace(/(\b(?:token|secret|password|api[_-]?key)=)[^\s&]+/gi, '$1[redacted]');
  output = output.replace(/([A-Za-z]:\\[^\s"']*(?:auth\.json|credentials|state_\d+\.sqlite|logs?_\d*\.sqlite))/gi, '[redacted-path]');
  return output;
}
