import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { loadConfig, sessionsDir } from "./config.js";
import { ensureRepo, pull as gitPull, preflightCheck } from "./git.js";
import { addToDeletedSet, deviceManifestExists, getGlobalSessionSet, readDeletedSet } from "./manifest.js";
import type { ProjectScope } from "./scope.js";
import { scopeProjectId } from "./scope.js";
import {
  checkOpenCodeInstalled,
  deleteSession,
  getSessionMap,
  importSession,
  isRemoteNewer,
  type PullResult,
  readSessionFromFile,
  type SessionInfo,
} from "./session.js";
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
  scope?: ProjectScope;
}): Promise<PullResult & { localMap?: Map<string, SessionInfo> }> {
  if (!checkOpenCodeInstalled()) {
    throw new Error("opencode не найден. Установите opencode: https://opencode.ai");
  }

  const config = loadConfig();
  const result: PullResult = { imported: 0, updated: 0, skipped: 0, errors: 0, deleted: 0 };

  await preflightCheck(config);
  ensureRepo(config.repo, config.localPath, config.branch);

  const scope = options?.scope ?? { type: "global" as const };

  console.log("Pull: загрузка изменений из remote...");
  try {
    gitPull(config.localPath, config.branch);
  } catch (err: any) {
    log(`[pull] Ошибка при git pull: ${err.message}`);
    log("[pull] Продолжаем с локальной копией");
  }

  const localMap = options?.localMap ?? getSessionMap();
  log(`[pull] Локальных сессий: ${localMap.size}`);

  const scopedSessDir = join(sessionsDir(config.localPath), scopeProjectId(scope));
  const files = findJsonFiles(scopedSessDir);
  log(`[pull] Файлов в репозитории (scope: ${scopeProjectId(scope)}): ${files.length}`);

  const deletedIds = readDeletedSet(config.localPath, config.deviceName);

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

    if (deletedIds.has(sessionId)) {
      log(`  ⏭ ${sessionTitle} (${sessionId}) — в deleted set, пропускаем`);
      result.skipped++;
      done++;
      continue;
    }

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
    const canDelete = deviceManifestExists(config.localPath, config.deviceName);
    if (!canDelete) {
      log("[pull] Манифест устройства не найден в репо — пропуск удаления (первая синхронизация)");
    }

    if (canDelete) {
      const globalAlive = getGlobalSessionSet(config.localPath);
      const scopeId = scopeProjectId(scope);
      const localIds = [...localMap.entries()]
        .filter(([, info]) => {
          const pid = info.projectId || "global";
          return pid === scopeId;
        })
        .map(([id]) => id);

      const newlyDeleted: string[] = [];

      for (const localId of localIds) {
        if (!globalAlive.has(localId)) {
          const sessionInfo = localMap.get(localId)!;
          log(`  🗑 ${sessionInfo.title || localId} (удалено на другом устройстве)`);
          if (deleteSession(localId)) {
            result.deleted++;
            newlyDeleted.push(localId);
          } else {
            result.errors++;
          }
        }
      }

      if (newlyDeleted.length > 0) {
        addToDeletedSet(config.localPath, config.deviceName, newlyDeleted);
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

  return { ...result, localMap };
}
