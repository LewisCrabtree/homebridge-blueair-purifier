export class CloudCooldownError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    message = 'Blueair is cooling down after throttling or an authentication failure',
  ) {
    super(message);
    this.name = 'CloudCooldownError';
  }
}

export class CloudHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Blueair HTTP ${status}`);
  }
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}

// Only this client instance is cooled down. Other app/client traffic can still consume the account quota.
export class RequestPolicy {
  private until = 0;
  private failures = 0;

  assertReady() {
    const remaining = this.remainingMs;
    if (remaining > 0) {
      throw new CloudCooldownError(remaining);
    }
  }

  get remainingMs() {
    return Math.max(0, this.until - Date.now());
  }

  throttle(header: string | null, minimumMs = 30000): CloudCooldownError {
    const delay = Math.max(minimumMs, Math.min(1800000, 30000 * 2 ** Math.min(this.failures++, 6)), retryAfterMs(header));
    this.until = Math.max(this.until, Date.now() + delay);
    return new CloudCooldownError(delay);
  }

  success() {
    this.failures = Math.max(0, this.failures - 1);
  }
}
