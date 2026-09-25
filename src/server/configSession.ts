import { randomBytes, timingSafeEqual } from 'node:crypto';
import { DodoError } from '../errors.js';

/** Process-private owner capability. Never serialize it to the dashboard. */
export interface ConfigSession {
  capability: string;
  expiresAt: number;
  active(): boolean;
  accepts(value: string): boolean;
  assertActive(): void;
  revoke(): void;
}

export function createConfigSession(expiresAt: number): ConfigSession {
  const capability = randomBytes(32).toString('hex');
  const expected = Buffer.from(capability);
  let revoked = false;
  const active = () => !revoked && Date.now() < expiresAt;
  return {
    capability, expiresAt, active,
    accepts(value) {
      const supplied = Buffer.from(value);
      return active() && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
    assertActive() {
      if (!active()) throw new DodoError('AUTH_REQUIRED', 'Config session expired or closed; open a new session from the owner CLI');
    },
    revoke() { revoked = true; },
  };
}
