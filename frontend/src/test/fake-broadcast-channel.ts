/**
 * P49: an in-memory BroadcastChannel for tests. Instances with the same name
 * receive each other's messages (never their own), asynchronously, as a
 * structured clone — like the browser. `stubGlobal` it per test.
 */
export class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  readonly sent: unknown[] = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error('InvalidStateError');
    this.sent.push(data);
    const clone: unknown = structuredClone(data);
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.closed || other.name !== this.name) continue;
      queueMicrotask(() => other.deliver(clone));
    }
  }

  /** Deliver a raw message to this instance, as if from another tab. */
  deliver(data: unknown, origin: string = window.location.origin): void {
    if (this.closed) return;
    this.onmessage?.call(this as unknown as BroadcastChannel, new MessageEvent('message', { data, origin }));
  }

  close(): void {
    this.closed = true;
  }

  static reset(): void {
    FakeBroadcastChannel.instances = [];
  }

  static open(): FakeBroadcastChannel[] {
    return FakeBroadcastChannel.instances.filter((c) => !c.closed);
  }
}
