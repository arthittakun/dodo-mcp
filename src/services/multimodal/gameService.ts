import { DodoError } from '../../errors.js';
import { newId } from '../../util/hash.js';
import { DesktopActionSchema } from '../desktop/protocol.js';
import type { DesktopPolicy } from '../desktop/protocol.js';
import { MediaStorage, actorKey, type Actor } from './storage.js';
import { ScreenService } from './images.js';
import { BrowserService } from './browserService.js';
import type { GameActionInput } from './contracts.js';

interface Game { id: string; owner: string; browserId?: string; windowId?: number; observationId: string; steps: number; expiresAt: number; busy: boolean }
export class GameService {
  private readonly games = new Map<string, Game>();
  constructor(private readonly storage: MediaStorage, private readonly screen: ScreenService, private readonly browser: BrowserService) {}
  private get(actor: Actor, id: string) { this.storage.check(); const g = this.games.get(id); if (!g || g.owner !== actorKey(actor) || g.expiresAt < Date.now()) throw new DodoError('NOT_FOUND', 'unknown/expired game session'); return g; }
  async open(actor: Actor, opts: { browserId?: string | undefined; windowId?: number | undefined }, check: () => void) {
    if ((opts.browserId === undefined) === (opts.windowId === undefined)) throw new DodoError('INVALID_INPUT', 'select exactly one browserId or permitted desktop windowId');
    if (this.games.size >= 8) throw new DodoError('RESOURCE_LIMIT', 'game session limit reached');
    const game: Game = { id: newId('game'), owner: actorKey(actor), observationId: '', steps: 0, expiresAt: Date.now() + 900000, busy: false, ...(opts.browserId ? { browserId: opts.browserId } : {}), ...(opts.windowId ? { windowId: opts.windowId } : {}) };
    this.games.set(game.id, game);
    try { return await this.observe(actor, game.id, check); } catch (err) { this.games.delete(game.id); throw err; }
  }
  async observe(actor: Actor, id: string, check: () => void) {
    const g = this.get(actor, id); if (g.busy) throw new DodoError('RESOURCE_LIMIT', 'game session busy');
    const observation = g.browserId ? await this.browser.observe(actor, g.browserId) : (await this.screen.observe(actor, { windowId: g.windowId!, maxEdge: 1280, count: 1, intervalMs: 0 }, check)).frames[0]!;
    g.observationId = observation.observationId;
    return { gameId: g.id, steps: g.steps, expiresAt: g.expiresAt, mode: g.browserId ? 'isolated_browser' : 'permitted_desktop', observation,
      note: 'The client model chooses moves. No background autoplay or win/score claim. Browser key holds are bounded; native desktop uses existing discrete actions only.' };
  }
  async step(actor: Actor, id: string, observationId: string, action: GameActionInput, check: () => void, gate: (policy?: DesktopPolicy) => void) {
    const g = this.get(actor, id); if (g.busy) throw new DodoError('RESOURCE_LIMIT', 'game session busy');
    if (g.observationId !== observationId) throw new DodoError('STALE_WORKSPACE', 'use the latest game observation');
    if (g.steps >= 1000) throw new DodoError('RESOURCE_LIMIT', 'session move budget reached; open a new reviewed session');
    if (!g.browserId && action.kind === 'keys' && (action.keys.length !== 1 || action.holdMs !== 0)) throw new DodoError('NOT_SUPPORTED', 'desktop games support one discrete key per step; simultaneous/held keys are available only in isolated browser games');
    g.busy = true; let dispatched = false;
    try {
      if (g.browserId) {
        gate(); const observation = await this.browser.gameStep(actor, g.browserId, observationId, action, check);
        g.steps++; g.observationId = observation.observationId;
        return { gameId: id, steps: g.steps, observation, note: 'Input dispatched and an after-frame captured; outcome must be evaluated by the client model.' };
      }
      const frame = this.screen.frame(actor, observationId); check();
      if (action.kind === 'wait') await new Promise(resolve => setTimeout(resolve, action.durationMs));
      else {
        const names: Record<string, string> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Space: 'space', Enter: 'enter', Escape: 'escape' };
        const native = DesktopActionSchema.parse(action.kind === 'click' ? { kind: 'click', x: action.x, y: action.y } : { kind: 'key', key: names[action.keys[0]!] ?? action.keys[0]!, modifiers: [] });
        await this.storage.services.desktop.action(frame.snapshotId, native, `game-${g.id}-${g.steps}-${observationId}`, actor, policy => { check(); gate(policy); });
        dispatched = true;
      }
      check();
      const observation = (await this.screen.observe(actor, { windowId: g.windowId!, maxEdge: 1280, count: 1, intervalMs: 0 }, check)).frames[0]!;
      g.steps++; g.observationId = observation.observationId;
      return { gameId: id, steps: g.steps, observation, note: 'Existing desktop snapshot/foreground/permission checks enforced. This is a discrete move, not low-latency continuous control.' };
    } catch (err) {
      // Once input was posted, a failed after-observation must never make the step retryable.
      if (dispatched) throw new DodoError('RECOVERY_REQUIRED', 'game input was posted but its outcome could not be observed; inspect before another move');
      throw err;
    } finally { g.busy = false; }
  }
  closeSession(actor: Actor, id: string) { this.get(actor, id); this.games.delete(id); return { closed: true, gameId: id }; }
  sweep() { for (const [id, game] of this.games) if (!game.busy && game.expiresAt <= Date.now()) this.games.delete(id); }
  close() { this.games.clear(); }
}
