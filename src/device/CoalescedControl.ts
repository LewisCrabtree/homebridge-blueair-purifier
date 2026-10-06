import { Mutex } from 'async-mutex';

export class CoalescedControl {
  private timer?: NodeJS.Timeout;
  private value = 0;
  private waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private readonly mutex = new Mutex();

  constructor(
    private readonly write: (value: number) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  submit(value: number): Promise<void> {
    this.value = value;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const result = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.delayMs);
    return result;
  }

  cancel() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error('Pending fan adjustment cancelled'));
    }
  }

  private async flush() {
    this.timer = undefined;
    const value = this.value;
    const waiters = this.waiters.splice(0);
    try {
      await this.mutex.runExclusive(() => this.write(value));
      for (const waiter of waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error as Error);
      }
    }
  }
}
