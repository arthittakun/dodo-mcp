import path from 'node:path';
import { z } from 'zod';
import type { AppServices } from '../../tools/context.js';
import type { DeploymentTarget } from './deploymentContracts.js';
import type { RecoveryEntry } from './contracts.js';
import { DodoError } from '../../errors.js';
import { newId } from '../../util/hash.js';
import { DEPLOYMENT_ARCHIVE_BYTES, verifySourceArchive } from './deploymentArchive.js';

const ImageDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ContainerId = z.string().regex(/^[a-f0-9]{64}$/);
export interface SourceProbe { name: string; claim: string; image: string; id?: string; removed: boolean }
export interface ContainerObservation { id: string; image: string; running: boolean; mounts: Array<{ type: string; destination: string }> }

/** Typed commands only. Never reads repo Compose configuration or falls back outside the owner's sandbox. */
export class DockerDeploymentAdapter {
  constructor(private readonly s: AppServices, private readonly actor: string, private readonly target: DeploymentTarget,
    private readonly revalidate: () => void, private readonly recordJob: (jobId: string, stage: string) => void,
    private readonly beforeEffect: () => Promise<void>, private readonly saveProbe: (probe: SourceProbe) => void) {}

  private async command(stage: string, args: string[], inputBytes?: Buffer, maxBytes = 1024 * 1024): Promise<Buffer> {
    this.revalidate();
    const job = await this.s.jobs.startProtected({ workspaceId: this.s.workspaceId, epoch: this.s.epoch, principal: this.actor,
      kind: 'exec', program: 'docker', args: ['--context', this.target.dockerContext, ...args], cwdRel: '.',
      timeoutMs: this.target.commandTimeoutMs, privateOutput: true, ...(inputBytes ? { inputBytes } : { stdin: false }) }, async () => {
      if (['build', 'compose-up', 'source-probe-create'].includes(stage)) await this.beforeEffect();
      this.revalidate();
    });
    // State transitions happen in the caller BEFORE the command; an unrecorded delivery is uncertain, never replayed.
    this.recordJob(job.jobId, stage);
    if (!await this.s.jobs.waitForExit(job.jobId, this.target.commandTimeoutMs + 5000))
      throw new DodoError('CONFLICT', 'deployment command outcome is uncertain; inspect before any new action', { detail: { jobId: job.jobId } });
    this.revalidate();
    try { return this.s.jobs.binaryOutput(job.jobId, this.s.workspaceId, this.actor, maxBytes); }
    catch { throw new DodoError('CONFLICT', 'deployment command failed or output is incomplete; private output hidden, not retried', { detail: { jobId: job.jobId } }); }
  }
  async build(deploymentId: string, archive: Buffer): Promise<string> {
    if (!/^deploy_[a-z0-9]{10}$/.test(deploymentId)) throw new DodoError('INVALID_INPUT', 'invalid deployment ID');
    const tag = `dodo-recovery:${deploymentId}`;
    await this.command('build', ['build', '--quiet', '--network=' + this.target.buildNetwork, '--tag', tag, '--file', this.target.dockerfile, '-'], archive);
    const output = await this.command('image-inspect', ['image', 'inspect', '--format', '{{.Id}}', tag]);
    return ImageDigest.parse(output.toString('utf8').trim());
  }
  async containers(): Promise<ContainerObservation[]> {
    const output = await this.command('service-inspect', ['container', 'ls', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${this.target.composeProject}`,
      '--filter', `label=com.docker.compose.service=${this.target.service}`, '--format', '{{.ID}}']);
    const ids = output.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (ids.length > 1) throw new DodoError('CONFLICT', 'this adapter requires exactly one container per registered service');
    const result: ContainerObservation[] = [];
    for (const id of ids) result.push(await this.inspectContainer(ContainerId.parse(id)));
    return result;
  }
  async inspectContainer(id: string): Promise<ContainerObservation> {
    ContainerId.parse(id);
    const output = await this.command('container-inspect', ['container', 'inspect', '--format', '{{json .}}', id]);
    const data = z.object({ Id: ContainerId, Image: ImageDigest, State: z.object({ Running: z.boolean() }),
      Mounts: z.array(z.object({ Type: z.string().max(64), Destination: z.string().max(4096) })).max(100) }).parse(JSON.parse(output.toString('utf8')));
    if (data.Id !== id) throw new DodoError('CONFLICT', 'container identity differs from inspected ID');
    return { id: data.Id, image: data.Image, running: data.State.Running, mounts: data.Mounts.map(m => ({ type: m.Type, destination: m.Destination })) };
  }
  compose(imageDigest: string): Buffer {
    ImageDigest.parse(imageDigest);
    const d = this.target;
    return Buffer.from(JSON.stringify({ services: { [d.service]: { image: imageDigest, pull_policy: 'never',
      ports: d.ports.map(p => ({ host_ip: p.host, published: String(p.published), target: p.target, protocol: 'tcp' })),
      volumes: d.volumes.map(v => ({ type: 'volume', source: v.name, target: v.target, volume: { nocopy: true } })) } },
      volumes: Object.fromEntries(d.volumes.map(v => [v.name, { external: true, name: v.name }])) }));
  }
  async deploy(imageDigest: string): Promise<void> {
    await this.command('compose-up', ['compose', '--project-name', this.target.composeProject, '--file', '-', 'up', '--detach', '--no-build', '--no-deps', '--pull', 'never', this.target.service], this.compose(imageDigest));
  }
  async sourceFromContainer(id: string, imageDigest: string, expected: RecoveryEntry[], assertPath: (path: string) => void) {
    if (!this.target.sourceMapping) throw new DodoError('NOT_SUPPORTED', 'this target has no declared source mapping; image labels do not prove source availability');
    const before = await this.inspectContainer(id), root = this.target.sourceMapping.containerRoot;
    if (before.image !== ImageDigest.parse(imageDigest)) throw new DodoError('CONFLICT', 'source container image differs from recorded image');
    if (before.mounts.some(m => m.destination === root || m.destination === '/' || root.startsWith(m.destination + '/') || m.destination.startsWith(root + '/')))
      throw new DodoError('PATH_DENIED', 'container source mapping overlaps mounted data; no copy was attempted');
    // No -L, docker exec, export of /, pause, stop or restart.
    const archive = await this.command('container-source-read', ['container', 'cp', `${id}:${root}`, '-'], undefined, Math.min(this.s.limits.jobLogBytesPerJob, DEPLOYMENT_ARCHIVE_BYTES));
    const result = await verifySourceArchive(archive, expected, assertPath, path.posix.basename(root));
    const after = await this.inspectContainer(id);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new DodoError('CONFLICT', 'container identity or mount state changed while inspecting source');
    return result;
  }
  /** Stopped disposable probe only; refuse declared volumes so image inspection cannot create data volumes. */
  async verifyImageSource(imageDigest: string, expected: RecoveryEntry[], assertPath: (path: string) => void) {
    ImageDigest.parse(imageDigest);
    const volumeOutput = await this.command('image-volumes', ['image', 'inspect', '--format', '{{json .Config.Volumes}}', imageDigest]);
    const volumes = JSON.parse(volumeOutput.toString('utf8')) as unknown;
    if (volumes !== null && (typeof volumes !== 'object' || Array.isArray(volumes) || Object.keys(volumes).length > 0))
      throw new DodoError('NOT_SUPPORTED', 'image declares data volumes; verify the approved running service mapping instead');
    const probe: SourceProbe = { name: newId('dodo-source-probe'), claim: newId('probeclaim'), image: imageDigest, removed: false };
    this.saveProbe(probe); // Durable intended identity BEFORE daemon delivery.
    const id = ContainerId.parse((await this.command('source-probe-create', ['container', 'create', '--network', 'none', '--name', probe.name,
      '--label', `dodo.recovery.probe=${probe.claim}`, '--entrypoint', '/dodo-never-executed', imageDigest])).toString('utf8').trim());
    probe.id = id; this.saveProbe(probe);
    try { return await this.sourceFromContainer(id, imageDigest, expected, assertPath); }
    finally { await this.removeProbe(probe); }
  }
  async probeObservation(probe: SourceProbe) {
    if (!/^dodo-source-probe_[a-z0-9]{10}$/.test(probe.name) || !/^probeclaim_[a-z0-9]{10}$/.test(probe.claim))
      throw new DodoError('RECOVERY_REQUIRED', 'invalid recorded probe identity');
    const output = await this.command('probe-find', ['container','ls','--all','--no-trunc','--filter',`name=^/${probe.name}$`,'--format','{{.ID}}']);
    const ids = output.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (!ids.length) return { present: false as const };
    if (ids.length !== 1 || (probe.id && ids[0] !== probe.id)) throw new DodoError('CONFLICT', 'recorded source probe was replaced');
    const id = ContainerId.parse(ids[0]);
    const result = await this.command('probe-identity', ['container','inspect','--format','{{json .}}',id]);
    const data = z.object({Name:z.string(),Config:z.object({Labels:z.record(z.string(),z.string())})}).parse(JSON.parse(result.toString('utf8')));
    const container = await this.inspectContainer(id);
    if (data.Name !== '/'+probe.name || data.Config.Labels['dodo.recovery.probe'] !== probe.claim || container.image !== probe.image || container.running || container.mounts.length)
      throw new DodoError('CONFLICT', 'probe identity, image, mounts or stopped state changed; no cleanup');
    return {present:true as const, id, image:container.image};
  }
  async removeProbe(probe: SourceProbe) {
    const observed = await this.probeObservation(probe);
    if (observed.present) await this.command('source-probe-remove',['container','rm',observed.id]);
    this.saveProbe({...probe,removed:true});
  }
  async imageInventory(image: string) {
    ImageDigest.parse(image);
    const output = await this.command('image-inventory',['image','ls','--no-trunc','--quiet']);
    const all = output.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (all.length > 10000) throw new DodoError('RESOURCE_LIMIT','Docker image inventory exceeds the bounded inspection limit');
    if (!all.includes(image)) return {present:false as const,tags:[] as string[],used:false};
    const raw = await this.command('image-tags',['image','inspect','--format','{{json .RepoTags}}',image]);
    const tags = z.array(z.string().max(512)).max(1000).nullable().parse(JSON.parse(raw.toString('utf8'))) ?? [];
    const usage = await this.command('image-users',['container','ls','--all','--no-trunc','--filter',`ancestor=${image}`,'--format','{{.ID}}']);
    return {present:true as const,tags:tags.sort(),used:usage.toString('utf8').trim().length>0};
  }
  async removeImage(image: string, expectedTags: string[]) {
    const live = await this.imageInventory(image);
    if (!live.present) throw new DodoError('CONFLICT','image disappeared after review; inspect again');
    if (live.used || JSON.stringify(live.tags)!==JSON.stringify([...expectedTags].sort())) throw new DodoError('CONFLICT','image references changed; no removal');
    // Only exact private managed tags (or an untagged ID), never force/prune.
    if (expectedTags.some(t=>!/^dodo-recovery:deploy_[a-z0-9]{10}$/.test(t))) throw new DodoError('PATH_DENIED','refusing non-DODO image tags');
    await this.command('image-remove',['image','rm',...(expectedTags.length?expectedTags:[ImageDigest.parse(image)])]);
    if((await this.imageInventory(image)).present)throw new DodoError('CONFLICT','image remains after tag removal; inspect outcome, do not repeat');
  }

}
