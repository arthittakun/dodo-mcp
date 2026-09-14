import type { GlobalConfig } from '../config/globalConfig.js';
import { DodoError } from '../errors.js';
import { startManagedTunnel, type RunningTunnelSupervisor, type TunnelStatus } from './supervisor.js';

/**
 * Owns at most one cloudflared supervisor for the lifetime of one DODO HTTP
 * process. It stores no credential: callers provide a run-scoped token for
 * each start, and the value is forwarded directly to the supervisor.
 */
export class TunnelRuntime {
  private supervisor: RunningTunnelSupervisor | undefined;
  private lastStatus: TunnelStatus | null = null;

  constructor(
    private readonly configDir: string,
    private readonly onLog?: (line: string) => void,
  ) {}

  status(): { available: true; running: boolean; current: TunnelStatus | null; lastKnown: TunnelStatus | null } {
    const current = this.supervisor?.status() ?? null;
    return { available: true, running: current?.running === true, current, lastKnown: current ?? this.lastStatus };
  }

  async start(config: GlobalConfig, temporaryToken: string): Promise<TunnelStatus> {
    if (this.supervisor?.status().running) {
      throw new DodoError('CONFLICT', 'Cloudflare Tunnel is already attached to this DODO process');
    }
    const supervisor = await startManagedTunnel({
      configDir: this.configDir,
      config,
      temporaryToken,
      ...(this.onLog ? { onLog: this.onLog } : {}),
    });
    this.supervisor = supervisor;
    const initial = supervisor.status();
    void supervisor.wait().then(() => {
      this.lastStatus = supervisor.status();
      if (this.supervisor === supervisor) this.supervisor = undefined;
    });
    return initial;
  }

  async stop(): Promise<TunnelStatus | null> {
    const supervisor = this.supervisor;
    if (!supervisor) return this.lastStatus;
    supervisor.stop();
    await supervisor.wait();
    this.lastStatus = supervisor.status();
    if (this.supervisor === supervisor) this.supervisor = undefined;
    return this.lastStatus;
  }

  close(): Promise<TunnelStatus | null> {
    return this.stop();
  }
}
