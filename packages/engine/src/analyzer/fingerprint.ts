import { createHash, type Hash } from 'node:crypto';

export interface FingerprintEntry {
  relativePath: string;
  content: Buffer | 'UNREADABLE';
}

const UNREADABLE_TAG = Buffer.from([0]);
const READABLE_TAG = Buffer.from([1]);

export class FingerprintAccumulator {
  private readonly hash: Hash = createHash('sha256');

  add(entry: FingerprintEntry): void {
    const path = Buffer.from(entry.relativePath, 'utf8');
    const readable = entry.content !== 'UNREADABLE';
    const content = readable ? entry.content : Buffer.alloc(0);
    this.hash.update(readable ? READABLE_TAG : UNREADABLE_TAG);
    this.hash.update(lengthPrefix(path.length));
    this.hash.update(path);
    this.hash.update(lengthPrefix(content.length));
    this.hash.update(content);
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}

export function fingerprintEntries(entries: FingerprintEntry[]): string {
  const fingerprint = new FingerprintAccumulator();
  for (const entry of entries.slice().sort((left, right) =>
    compareExact(left.relativePath, right.relativePath))) {
    fingerprint.add(entry);
  }
  return fingerprint.digest();
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

function compareExact(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
