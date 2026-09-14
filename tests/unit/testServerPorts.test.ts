import { describe, expect, it } from 'vitest';
import { freePort } from '../helpers/testServer.js';

describe('test HTTP port allocator', () => {
  it('does not return duplicate ports to parallel fixtures', async () => {
    const ports = await Promise.all(Array.from({ length: 32 }, () => freePort()));
    expect(new Set(ports).size).toBe(ports.length);
  });
});
