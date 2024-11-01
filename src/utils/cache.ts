import { Database } from "bun:sqlite";

interface CacheOptions {
  filename?: string;
  cleanupInterval?: number;
  maxSize?: number;
}

export class UltraCache {
  private db: Database;
  private cleanupTimer: Timer | null = null;
  private maxSize: number;
  private prepared: {
    get: any;
    set: any;
    delete: any;
    clear: any;
    cleanup: any;
    size: any;
    oldest: any;
  };

  constructor(options: CacheOptions = {}) {
    const {
      filename = ":memory:",
      cleanupInterval = 60000,
      maxSize = 10000,
    } = options;

    this.maxSize = maxSize;
    this.db = new Database(filename);

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA cache_size = -64000;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_expires_at ON cache(expires_at);
    `);

    this.prepared = {
      get: this.db.query("SELECT value, expires_at FROM cache WHERE key = ?1"),
      set: this.db.query(
        "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)"
      ),
      delete: this.db.query("DELETE FROM cache WHERE key = ?1"),
      clear: this.db.query("DELETE FROM cache"),
      cleanup: this.db.query("DELETE FROM cache WHERE expires_at <= ?1"),
      size: this.db.query("SELECT COUNT(*) as count FROM cache"),
      oldest: this.db.query(
        "SELECT key FROM cache ORDER BY expires_at ASC LIMIT ?1"
      ),
    };

    if (cleanupInterval > 0) {
      this.startCleanup(cleanupInterval);
    }
  }

  set(key: string, value: any, ttl: number): void {
    const expiresAt = Date.now() + ttl;

    if (ttl <= 0) {
      this.delete(key);
      return;
    }

    this.db.transaction(() => {
      const size = this.prepared.size.get().count;

      if (size >= this.maxSize) {
        const toDelete = Math.ceil(this.maxSize * 0.1);
        const oldestKeys = this.prepared.oldest.all(toDelete);
        for (const { key } of oldestKeys) {
          this.prepared.delete.run(key);
        }
      }

      let valueToStore: string | null = null;

      if (value === undefined) {
        valueToStore = null;
      } else if (value === null) {
        valueToStore = "null";
      } else {
        try {
          valueToStore = JSON.stringify(value);
        } catch {
          valueToStore = null;
        }
      }

      this.prepared.set.run(key, valueToStore, expiresAt);
    })();
  }

  get(key: string): any | undefined {
    const result = this.prepared.get.get(key);

    if (!result || result.expires_at <= Date.now()) {
      this.delete(key);
      return undefined;
    }

    if (result.value === null) {
      return undefined;
    }

    if (result.value === "null") {
      return null;
    }

    try {
      return JSON.parse(result.value);
    } catch {
      this.delete(key);
      return undefined;
    }
  }

  delete(key: string): void {
    this.prepared.delete.run(key);
  }

  clear(): void {
    this.prepared.clear.run();
  }

  private startCleanup(interval: number): void {
    this.cleanupTimer = setInterval(() => {
      this.prepared.cleanup.run(Date.now());
    }, interval);
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.db.close();
  }
}

export const cache = new UltraCache({
  filename: ":memory:",
  cleanupInterval: 1000,
  maxSize: 5000,
});