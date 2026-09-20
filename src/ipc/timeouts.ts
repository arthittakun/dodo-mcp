/** Extended waits apply only after authenticated owner dispatch. No command is retried on timeout. */
export function ownerCommandTimeout(cmd: string): number {
  return ['recovery.config.configure','recovery.config.backup','recovery.config.preview','recovery.config.apply','recovery.config.rotate','deployment.build', 'deployment.apply', 'deployment.observe', 'deployment.source_preview', 'deployment.rollback_prepare','deployment.maintenance'].includes(cmd) ? 45 * 60000 : 10000;
}
