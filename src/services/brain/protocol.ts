import type { ParsedBrainFileData } from './contracts.js';

export interface BrainParseRequest {
  id: number;
  path: string;
  text: string;
}

export type BrainParseResponse =
  | { id: number; ok: true; data: ParsedBrainFileData }
  | { id: number; ok: false; error: { code: 'INVALID_INPUT' | 'INTERNAL_ERROR'; message: string } };
