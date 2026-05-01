import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sessionsDir } from "./config.js";
import { ensureRepo, push as gitPush, preflightCheck } from "./git.js";
import {
  addToDeletedSet,
  deviceManifestExists,
  findOrphanFiles,
  getGlobalSessionSet,
  readManifest,
  writeManifest,
} from "./manifest.js";
import type { ProjectScope } from "./scope.js";
import { scopeProjectId } from "./scope.js";
import {
  checkOpenCodeInstalled,
  exportSessionAsync,
  isLocalNewer,
  listSessions,
  type PushResult,
  type SessionInfo,
  saveSessionToFile,
} from "./session.js";
import { EXPORT_CONCURRENCY, log, promisePool, withLockAsync } from "./util.js";

function filterSessionsByScope(sessions: SessionInfo[], scope: ProjectScope): SessionInfo[] {
  if (scope.type === "global") {
    return sessions.filter((s) => !s.projectId || s.projectId === "global");
  }
  return sessions.filter((s) => s.projectId === scope.projectId);
}

export async function pushSessions(options?: {
  dryRun?: boolean;
  sessions?: SessionInfo[];
  scope?: ProjectScope;
}): Promise<PushResult> {
  if (!checkOpenCodeInstalled()) {
    throw new Error("opencode не найден. Установите opencode: https://opencode.ai");
  }

  const config = loadConfig();
  const result: PushResult = { exported: 0, skipped: 0, errors: 0 };

  await preflightCheck(config);
  ensureRepo(config.repo, config.localPath, config.branch);

  const allSessions = options?.sessions ?? listSessions();
  const scope = options?.scope ?? { type: "global" as const };
  const isFirstPush = !deviceManifestExists(config.localPath, config.deviceName);
  const scopedSessions = isFirstPush ? allSessions : filterSessionsByScope(allSessions, scope);

  if (isFirstPush) {
    log("[push] Первый push — экспорт всех сессий без фильтрации по scope");
  }

  const freshnessMap = new Map<string, boolean>();
  for (const s of scopedSessions) {
    if (!s.id) {
      freshnessMap.set(s.id, false);
      continue;
    }
    const filePath = join(sessionsDir(config.localPath), s.projectId || "global", `${s.id}.json`);
    freshnessMap.set(s.id, isLocalNewer(s, filePath));
  }

  const newCount = [...freshnessMap.values()].filter(Boolean).length;
  console.log(`Push: ${scopedSessions.length} сессий (scope: ${scopeProjectId(scope)}), ${newCount} новых/изменённых`);

  const toExport: SessionInfo[] = [];

  for (const session of scopedSessions) {
    if (!session.id || !freshnessMap.get(session.id)) {
      result.skipped++;
      continue;
    }

    if (options?.dryRun) {
      log(`  [dry-run] Экспорт: ${session.title} (${session.id})`);
      result.exported++;
      continue;
    }

    toExport.push(session);
  }

  if (toExport.length > 0) {
    let done = 0;
    const total = toExport.length;

    const exportResults = await promisePool(toExport, EXPORT_CONCURRENCY, async (session) => {
      try {
        const data = await exportSessionAsync(session.id);
        if (!data) return { kind: "skipped" as const };
        saveSessionToFile(data, config.localPath);
        done++;
        process.stdout.write(`\r  Экспорт: ${done}/${total}`);
        return { kind: "exported" as const };
      } catch (err: any) {
        done++;
        process.stdout.write(`\r  Экспорт: ${done}/${total}`);
        log(`  ✗ ${session.title}: ${err.message}`);
        return { kind: "error" as const };
      }
    });

    if (done > 0) process.stdout.write("\n");

    for (const r of exportResults) {
      if (r.kind === "exported") result.exported++;
      else if (r.kind === "skipped") result.skipped++;
      else if (r.kind === "error") result.errors++;
    }
  }

  if (!options?.dryRun) {
    const localIds = new Set(allSessions.filter((s) => s.id).map((s) => s.id));
    const oldManifest = readManifest(config.localPath, config.deviceName);

    const removedIds = [...oldManifest].filter((id) => !localIds.has(id));
    if (removedIds.length > 0) {
      addToDeletedSet(config.localPath, config.deviceName, removedIds);
      log(`[push] ${removedIds.length} сессий удалено, добавлено в deleted set`);
    }

    writeManifest(config.localPath, config.deviceName, localIds);

    const globalAlive = getGlobalSessionSet(config.localPath);
    const scopedSessDir = join(sessionsDir(config.localPath), scopeProjectId(scope));
    const orphans = findOrphanFiles(scopedSessDir, globalAlive);

    if (orphans.length > 0) {
      for (const file of orphans) {
        try {
          unlinkSync(file);
          log(`  🗑 ${join("", file.split("/").slice(-2).join("/"))}`);
        } catch (err: any) {
          log(`  ✗ Не удалось удалить ${file}: ${err.message}`);
        }
      }
      console.log(`  Удалено orphan-файлов: ${orphans.length}`);
    }

    if (result.exported > 0 || orphans.length > 0 || removedIds.length > 0) {
      log(`[push] Экспортировано: ${result.exported}, пропущено: ${result.skipped}`);
      await withLockAsync(config.localPath, () => gitPush(config.localPath, config.branch, config.deviceName));
      console.log(
        `Готово: ${result.exported} экспортировано, ${result.skipped} пропущено${orphans.length > 0 ? `, ${orphans.length} удалено` : ""}`,
      );
    } else {
      log("[push] Все сессии актуальны, нет изменений для push");
      console.log("Push: нет изменений");
    }
  }

  return result;
}
