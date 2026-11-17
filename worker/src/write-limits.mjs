// Per-client write budgets for the yataverse.com Worker (AWAI-3160).
// Owner decision 2026-11-18: Workers Rate Limiting bindings, keyed by client IP, for both the
// number of writes and the bytes written. No KV, D1, Durable Objects or R2 (ADR 0031 D1).
//
//   WRITE_REQUEST_LIMITER  one unit per write request (block PUT, CAR POST, Drive pack PUT)
//   WRITE_MIB_LIMITER      one unit per started MiB of request body
//
// The binding's window is 10 or 60 seconds and its counters are kept per Cloudflare location,
// so these are per-minute, per-location budgets, not exact global or daily quotas.
// Writes fail closed (503) when either binding is missing.

export const MIB = 1024 * 1024;

const clientKey = (request) => request.headers.get('cf-connecting-ip') || 'unknown-client';

async function take(limiter, key, units) {
  for (let i = 0; i < units; i++) {
    const { success } = await limiter.limit({ key });
    if (!success) return false;
  }
  return true;
}

/** Before reading the body: count the request. -> null, or [status, error, headers]. */
export async function admitWriteRequest(request, env) {
  if (!env.WRITE_REQUEST_LIMITER || !env.WRITE_MIB_LIMITER) return [503, 'write-limits-not-configured', {}];
  if (!(await take(env.WRITE_REQUEST_LIMITER, clientKey(request), 1))) return [429, 'write-rate-limited', { 'retry-after': '60' }];
  return null;
}

/** After reading the body, before storing: count its size in MiB (at least 1). */
export async function admitWriteBytes(request, env, length) {
  const units = Math.max(1, Math.ceil(length / MIB));
  if (!(await take(env.WRITE_MIB_LIMITER, clientKey(request), units))) return [429, 'write-bytes-limited', { 'retry-after': '60' }];
  return null;
}
