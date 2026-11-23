/** Redacción de secretos para logs, eventos y errores públicos (RNF-006). */
const REPLACEMENT = "[REDACTED]";

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /(?<=:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g, // contraseña embebida en URL
];

const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi;

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, REPLACEMENT);
  return out.replace(KEY_VALUE, (_m, k: string, sep: string) => `${k}${sep}${REPLACEMENT}`);
}

export const containsSecret = (input: string): boolean => redactSecrets(input) !== input;

/** Rutas que nunca deben enviarse a un proveedor externo ni listarse en diffs exportados. */
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /\.(pem|key|pfx|p12)$/i,
  /(^|[\\/])\.npmrc$/i,
];
export const isSensitivePath = (p: string): boolean => SENSITIVE_PATH_PATTERNS.some((re) => re.test(p));
