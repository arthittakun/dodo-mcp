import type { AppServices } from '../../tools/context.js';
import { MediaStorage } from './storage.js';
import { ScreenService } from './images.js';
import { MediaService } from './mediaService.js';
import { BrowserService } from './browserService.js';
import { GameService } from './gameService.js';
import { WorkflowService } from './workflowService.js';

/** One instance per workspace/epoch. Services are lazy: constructing this opens no browser, camera, microphone or decoder. */
export class MultimodalService {
  readonly storage: MediaStorage;
  readonly screen: ScreenService;
  readonly media: MediaService;
  readonly browser: BrowserService;
  readonly games: GameService;
  readonly workflows: WorkflowService;
  private closePromise: Promise<void> | undefined;
  private readonly cleanupTimer: NodeJS.Timeout;
  private sweeping: Promise<void> | undefined;
  constructor(services: AppServices, configDir: string) {
    this.storage = new MediaStorage(services, configDir);
    this.screen = new ScreenService(this.storage);
    this.media = new MediaService(this.storage);
    this.browser = new BrowserService(this.storage);
    this.games = new GameService(this.storage, this.screen, this.browser);
    this.workflows = new WorkflowService(this.storage, this.screen, this.browser);
    this.cleanupTimer = setInterval(() => {
      if (this.storage.closed || this.sweeping) return;
      this.storage.sweep(); this.games.sweep(); this.workflows.sweep();
      this.sweeping = Promise.all([this.media.sweep(), this.browser.sweep()]).then(() => undefined).catch(() => undefined).finally(() => { this.sweeping = undefined; });
    }, 15000);
    this.cleanupTimer.unref();
  }
  close(): Promise<void> {
    if (!this.closePromise) {
      this.storage.closed = true;
      clearInterval(this.cleanupTimer);
      this.closePromise = (async () => {
        await this.sweeping;
        await Promise.all([this.media.close(), this.browser.close()]);
        this.screen.close(); this.games.close(); this.workflows.close(); this.storage.close();
      })();
    }
    return this.closePromise;
  }
}
