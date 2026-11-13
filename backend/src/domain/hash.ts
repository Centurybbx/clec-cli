import { createHash } from 'node:crypto';
export const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
