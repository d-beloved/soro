/**
 * Runs tasks one at a time per key (per sender), so two quick messages from the same
 * trader can't race each other through onboarding or double-count a record.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task).catch(() => undefined);
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }
}
