import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OSRecoveryKeys } from '../../src/services/recovery/configKeys.js';

// Explicit local/CI opt-in only; this creates and removes its own random key.
// No owner credential is read, changed or exported. Headless Linux without
// Secret Service remains NOT_RUN, never a fake successful encryption backend.
describe.skipIf(process.env['DODO_TEST_OS_RECOVERY_KEYS'] !== '1')('actual OS recovery key store', () => {
  it('writes a dedicated random key over stdin, reads it back and deletes only that item', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dodo-recovery-os-key-'));
    const store=new OSRecoveryKeys(root), reference='recoverykey_'+randomBytes(16).toString('hex'), key=randomBytes(32);
    let installed=false;
    try {
      await store.put(reference,key);installed=true;
      const actual=await store.get(reference);
      try { expect(timingSafeEqual(key,actual)).toBe(true); } finally { actual.fill(0); }
      await store.delete(reference);installed=false;
      await expect(store.get(reference)).rejects.toThrow();
    } finally { key.fill(0);if(installed)await store.delete(reference);fs.rmSync(root,{recursive:true,force:true}); }
  },90000);
});
