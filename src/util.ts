import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OPENCODE_TIMEOUT_MS = 30_000;
export const OPENCODE_MAX_BUFFER = 50 * 1024 * 1024;
export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_BUFFER = 20 * 1024 * 1024;
export const EXPORT_CONCURRENCY = 5;
export const RETRY_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 1000;
export const LOCKFILE_NAME = ".opencode-sync.lock";
export const SESSION_ID_RE = /^[a-zA-Z0-9_]+$/;

export function validateSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
}

export function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export async function promisePool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const errors: any[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = fn(item).then(
      (r) => {
        results.push(r);
      },
      (err) => {
        errors.push(err);
      },
    );
    executing.add(p as Promise<void>);
    p.finally(() => executing.delete(p as Promise<void>));

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  if (errors.length > 0) throw errors[0];
  return results;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(lockDir: string): void {
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, LOCKFILE_NAME);

  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (!Number.isNaN(pid) && isProcessRunning(pid)) {
      throw new Error(`opencode-sync уже запущен (PID ${pid}). Если это ошибка, удалите ${lockPath}`);
    }
    try {
      unlinkSync(lockPath);
    } catch {}
  }

  writeFileSync(lockPath, String(process.pid), "utf-8");
}

export function releaseLock(lockDir: string): void {
  const lockPath = join(lockDir, LOCKFILE_NAME);
  try {
    unlinkSync(lockPath);
  } catch {}
}

export function withLock<T>(lockDir: string, fn: () => T): T {
  acquireLock(lockDir);
  try {
    return fn();
  } finally {
    releaseLock(lockDir);
  }
}

export async function withLockAsync<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  acquireLock(lockDir);
  try {
    return await fn();
  } finally {
    releaseLock(lockDir);
  }
}

export async function withRetry<T>(
  fn: () => T | Promise<T>,
  retries: number = RETRY_ATTEMPTS,
  delayMs: number = RETRY_DELAY_MS,
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        log(`[retry] Попытка ${attempt}/${retries} не удалась: ${err.message}`);
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastError;
}
