import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
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

export async function pullSessions(options?: {
  dryRun?: boolean;
  localMap?: Map<string, SessionInfo>;
}): Promise<PullResult> {
  const config = loadConfig();
  const result: PullResult = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  ensureRepo(config.repo, config.localPath, config.branch);

  log("[pull] Подтягивание изменений из remote...");
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

  for (const filePath of files) {
    const fileData = readSessionFromFile(filePath);
    if (!fileData) {
      result.errors++;
      continue;
    }

    const sessionId = fileData.info.id;
    const sessionTitle = fileData.info.title || sessionId;
    const isLocal = localMap.has(sessionId);

    if (!isRemoteNewer(fileData, localMap)) {
      result.skipped++;
      continue;
    }

    if (options?.dryRun) {
      const action = isLocal ? "обновить" : "импорт";
      log(`  [dry-run] ${action}: ${sessionTitle} (${sessionId})`);
      if (isLocal) result.updated++;
      else result.imported++;
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
      } else {
        result.errors++;
      }
    });
  }

  log(
    `\n[pull] Итого: импортировано ${result.imported}, ` +
      `обновлено ${result.updated}, ` +
      `пропущено ${result.skipped}, ` +
      `ошибок ${result.errors}`,
  );

  return result;
}
