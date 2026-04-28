import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { loadConfig, sessionsDir } from "./config.js";
import {
  getSessionMap,
  readSessionFromFile,
  importSession,
  isRemoteNewer,
  type PullResult,
  type SessionInfo,
} from "./session.js";
import { pull as gitPull, ensureRepo } from "./git.js";
import { log, withLock } from "./util.js";
import { getGlobalSessionSet } from "./manifest.js";
import Database from "better-sqlite3";

function findJsonFiles(dir: string): string[] {
  const results: string[] = [];

  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return results;
  }

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".json") {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function deleteSessionFromDb(sessionId: string): boolean {
  try {
    const dbPath = process.env.OPENCODE_DB || join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
      "opencode",
      "opencode.db",
    );

    if (!statSync(dbPath, { throwIfNoEntry: false })) return false;

    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
      return true;
    } finally {
      db.close();
    }
  } catch (err: any) {
    log(`[pull] Не удалось удалить сессию ${sessionId}: ${err.message}`);
    return false;
  }
}

export async function pullSessions(options?: {
  dryRun?: boolean;
  localMap?: Map<string, SessionInfo>;
}): Promise<PullResult> {
  const config = loadConfig();
  const result: PullResult = { imported: 0, updated: 0, skipped: 0, errors: 0, deleted: 0 };

  ensureRepo(config.repo, config.localPath, config.branch);

  console.log("Pull: загрузка изменений из remote...");
  try {
    gitPull(config.localPath, config.branch);
  } catch (err: any) {
    log(`[pull] Ошибка при git pull: ${err.message}`);
    log("[pull] Продолжаем с локальной копией");
  }

  const localMap = options?.localMap ?? getSessionMap();
  log(`[pull] Локальных сессий: ${localMap.size}`);

  const sessDir = sessionsDir(config.localPath);
  const files = findJsonFiles(sessDir);
  log(`[pull] Файлов в репозитории: ${files.length}`);

  let done = 0;
  const total = files.length;

  for (const filePath of files) {
    const fileData = readSessionFromFile(filePath);
    if (!fileData) {
      result.errors++;
      done++;
      continue;
    }

    const sessionId = fileData.info.id;
    const sessionTitle = fileData.info.title || sessionId;
    const isLocal = localMap.has(sessionId);

    if (!isRemoteNewer(fileData, localMap)) {
      result.skipped++;
      done++;
      continue;
    }

    if (options?.dryRun) {
      const action = isLocal ? "обновить" : "импорт";
      log(`  [dry-run] ${action}: ${sessionTitle} (${sessionId})`);
      if (isLocal) result.updated++;
      else result.imported++;
      done++;
      continue;
    }

    withLock(config.localPath, () => {
      const success = importSession(filePath);
      if (success) {
        if (isLocal) {
          result.updated++;
          log(`  ↑ ${sessionTitle} (обновлено)`);
        } else {
          result.imported++;
          log(`  + ${sessionTitle} (новая)`);
        }
        done++;
        process.stdout.write(`\r  Импорт: ${done}/${total}`);
      } else {
        result.errors++;
        done++;
      }
    });
  }

  if (done > 0 && !options?.dryRun) process.stdout.write("\n");

  if (!options?.dryRun) {
    const globalAlive = getGlobalSessionSet(config.localPath);
    const localIds = [...localMap.keys()];

    for (const localId of localIds) {
      if (!globalAlive.has(localId)) {
        const sessionInfo = localMap.get(localId)!;
        log(`  🗑 ${sessionInfo.title || localId} (удалено на другом устройстве)`);
        if (deleteSessionFromDb(localId)) {
          result.deleted++;
        } else {
          result.errors++;
        }
      }
    }

    if (result.deleted > 0) {
      console.log(`  Удалено локальных сессий: ${result.deleted}`);
    }
  }

  const parts = [];
  if (result.imported > 0) parts.push(`${result.imported} импортировано`);
  if (result.updated > 0) parts.push(`${result.updated} обновлено`);
  if (result.deleted > 0) parts.push(`${result.deleted} удалено`);
  if (result.skipped > 0) parts.push(`${result.skipped} пропущено`);

  console.log(`Готово: ${parts.length > 0 ? parts.join(", ") : "нет изменений"}`);

  return result;
}
