import { z } from 'zod';

const GiB = 1024 ** 3;
export const RecoveryPolicySchema = z.object({
  version: z.literal(1).default(1),
  enabled: z.boolean().default(true),
  scanMs: z.number().int().min(100).max(60000).default(15000),
  massFiles: z.number().int().min(1).max(100000).default(20),
  massPercent: z.number().min(0).max(100).default(20),
  deletedFiles: z.number().int().min(1).max(100000).default(10),
  gitRequired: z.boolean().default(false),
  gitDirectory: z.string().max(2048).nullable().default(null),
  projectBytes: z.number().int().min(1024 * 1024).max(100 * GiB).default(5 * GiB),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  retainedPoints: z.number().int().min(1).max(10000).default(200),
  fileBytes: z.number().int().min(1024).max(GiB).default(64 * 1024 * 1024),
  maxEntries: z.number().int().min(1).max(1000000).default(100000),
  dataRoots: z.array(z.string().min(1).max(1024)).max(100).default([]),
}).strict();
export type RecoveryPolicy = z.infer<typeof RecoveryPolicySchema>;
export const RecoveryInstallationSchema = z.object({
  version: z.literal(1).default(1),
  storageBytes: z.number().int().min(1024 * 1024).max(1024 * GiB).default(20 * GiB),
  freeFloorBytes: z.number().int().min(0).max(100 * GiB).default(500 * 1024 * 1024),
}).strict();
export type RecoveryInstallationPolicy = z.infer<typeof RecoveryInstallationSchema>;
export interface RecoveryEntry { path: string; kind: 'file' | 'directory' | 'absent'; hash: string | null; bytes: number; mode: number | null; identity?: string }
export interface RecoveryManifest {
  version: 1; id: string; workspaceId: string; projectId: string;
  root: string; rootIdentity: string; epoch: string; sessionId: string; actor: string;
  trigger: 'activation' | 'before-write' | 'before-exec' | 'owner-checkpoint' | 'emergency-observed' | 'verified-checkpoint';
  scope: 'source' | 'targets'; createdAt: number; policyDigest: string;
  entries: RecoveryEntry[]; excludedByPolicy: number; complete: true;
}
export type RecoveryTrigger = RecoveryManifest['trigger'];
