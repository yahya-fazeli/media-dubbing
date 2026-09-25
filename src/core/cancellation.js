import { CancelledError } from './errors.js';

/**
 * Cooperative cancellation token. Long-running operations receive one of these
 * and should call `throwIfCancelled()` at natural checkpoints (between segments,
 * before each provider attempt, around media subprocesses).
 */
export class CancelToken {
  #cancelled = false;
  #reason = null;
  #listeners = new Set();
  #controllers = new Set();
  // Backing AbortController. The token is handed to subprocess runners, fetch
  // callers, and sleep() as their `signal`, all of which expect the standard
  // AbortSignal interface (addEventListener/aborted/reason). Going through a real
  // controller keeps that contract while the cooperative token keeps its own
  // richer API on top.
  #controller = new AbortController();

  get cancelled() { return this.#cancelled; }
  get aborted() { return this.#controller.signal.aborted; }
  get reason() { return this.#reason; }
  /** The underlying AbortSignal, for callers that want one directly. */
  get signal() { return this.#controller.signal; }

  cancel(reason = 'Cancelled by user') {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#reason = reason;
    // Abort with an Error reason so consumers that branch on `reason` (sleep,
    // fetch wrappers) surface something `isCancellation` recognises instead of a
    // bare string.
    try {
      this.#controller.abort(reason instanceof Error ? reason : new CancelledError(reason));
    } catch { /* already aborted */ }
    for (const controller of this.#controllers) {
      try { controller.abort(reason); } catch { /* already aborted */ }
    }
    this.#controllers.clear();
    for (const listener of this.#listeners) {
      try { listener(reason); } catch { /* listener errors must not break cancel */ }
    }
    this.#listeners.clear();
  }

  addEventListener(type, listener, options) {
    this.#controller.signal.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    this.#controller.signal.removeEventListener(type, listener, options);
  }

  throwIfCancelled() {
    if (this.#cancelled) throw new CancelledError(this.#reason ?? 'Cancelled by user');
  }

  onCancel(listener) {
    if (this.#cancelled) {
      listener(this.#reason);
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Registers an AbortController so in-flight fetches and subprocesses are torn
   * down immediately when cancellation fires, not just at the next checkpoint.
   */
  register(controller) {
    if (this.#cancelled) {
      try { controller.abort(this.#reason); } catch { /* noop */ }
      return () => {};
    }
    this.#controllers.add(controller);
    return () => this.#controllers.delete(controller);
  }

  /** Creates a controller already wired to this token. */
  createController() {
    const controller = new AbortController();
    const release = this.register(controller);
    return { controller, release, signal: controller.signal };
  }

  /** A child token that also cancels when the parent cancels. */
  child() {
    const child = new CancelToken();
    this.onCancel((reason) => child.cancel(reason));
    return child;
  }

  /** Builds a promise that rejects as soon as cancellation fires. */
  race(promise) {
    if (this.#cancelled) return Promise.reject(new CancelledError(this.#reason));
    return new Promise((resolve, reject) => {
      const off = this.onCancel((reason) => reject(new CancelledError(reason)));
      promise.then(
        (value) => { off(); resolve(value); },
        (err) => { off(); reject(err); },
      );
    });
  }
}

export function isCancellation(err) {
  return err instanceof CancelledError || err?.code === 'CANCELLED' || err?.name === 'AbortError';
}
