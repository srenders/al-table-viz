import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AppPackageResult } from './appPackageReader';

/**
 * Disk cache for parsed .app symbol package results.
 * Cache entries are stored as JSON files in a directory under the extension's
 * global storage, keyed by SHA-256(filePath:mtime:size). This means the cache
 * survives VS Code window reloads but is automatically bypassed whenever the
 * .app file changes on disk.
 */
export class AppPackageCache {
  constructor(private readonly cacheDir: string) {}

  /**
   * Cache key is SHA-256 of the raw file content bytes.
   * Path-independent: two copies of the same .app at different paths share one entry.
   */
  private _key(contentHash: string): string {
    return contentHash;
  }

  /**
   * Compute the SHA-256 hex digest of a Buffer — used by the scanner to derive
   * the contentHash before calling get/set.
   */
  static hashBytes(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  async get(contentHash: string): Promise<AppPackageResult | null> {
    const cachePath = path.join(this.cacheDir, `${this._key(contentHash)}.json`);
    try {
      const data = await fs.readFile(cachePath, 'utf8');
      return JSON.parse(data) as AppPackageResult;
    } catch {
      return null;
    }
  }

  async set(contentHash: string, result: AppPackageResult): Promise<void> {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cachePath = path.join(this.cacheDir, `${this._key(contentHash)}.json`);
      await fs.writeFile(cachePath, JSON.stringify(result), 'utf8');
    } catch {
      // Cache write failure is non-fatal — next run will re-parse
    }
  }

  async clear(): Promise<void> {
    try {
      const files = await fs.readdir(this.cacheDir);
      await Promise.all(files.map(f => fs.unlink(path.join(this.cacheDir, f)).catch(() => {})));
    } catch {
      // Directory may not exist — that's fine
    }
  }
}
