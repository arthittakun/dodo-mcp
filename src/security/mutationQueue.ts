import { AsyncLocalStorage } from 'node:async_hooks';
import { DodoError } from '../errors.js';

interface Ticket { refs: number; open: boolean; release: () => void }
/** One queue per real workspace; nested dispatch shares its ticket, background jobs retain it. */
export class MutationQueue {
  private readonly context = new AsyncLocalStorage<Ticket>();
  private active: Ticket | undefined;
  private waiters: Array<(ticket: Ticket) => void> = [];
  get busy(): boolean { return this.active !== undefined; }
  get pending(): number { return this.waiters.length; }
  private ticket(): Ticket {
    const t: Ticket = { refs: 1, open: true, release: () => {
      if (--t.refs !== 0) return;
      if (this.active === t) this.active = undefined;
      const next = this.waiters.shift();
      if (next) next(this.ticket());
    } };
    this.active = t;
    return t;
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DodoError('CONFLICT','queued action was canceled');
    const nested = this.context.getStore();
    if (nested?.open && this.active === nested) return fn();
    let ticket: Ticket;
    if (this.busy) {
      if (this.waiters.length >= 32) throw new DodoError('RESOURCE_LIMIT', 'workspace mutation queue is full');
      ticket = await new Promise<Ticket>((resolve,reject) => {
        const waiter = (t:Ticket) => { signal?.removeEventListener('abort',abort); resolve(t); };
        const abort = () => { const i=this.waiters.indexOf(waiter);if(i>=0){this.waiters.splice(i,1);reject(new DodoError('CONFLICT','queued action was canceled'));} };
        this.waiters.push(waiter);signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
      });
    } else ticket = this.ticket();
    try { return await this.context.run(ticket, fn); }
    finally { ticket.open = false; ticket.release(); }
  }
  assertCanStart(): void {
    const ticket = this.context.getStore();
    if (this.busy && (!ticket?.open || ticket !== this.active)) throw new DodoError('CONFLICT', 'workspace mutation queue is busy');
  }
  /** Sync producers (schedules) refuse a busy queue; they may retry before claiming a due run. */
  retainJob(): () => void {
    let ticket = this.context.getStore();
    if (!ticket?.open || ticket !== this.active) {
      if (this.busy) throw new DodoError('CONFLICT', 'workspace mutation queue is busy; wait for the current job');
      ticket = this.ticket();
      ticket.open = false;
    } else ticket.refs++;
    let done = false;
    return () => { if (!done) { done = true; ticket.release(); } };
  }
}
