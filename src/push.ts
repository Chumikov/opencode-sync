import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sessionsDir } from "./config.js";
import { ensureRepo, push as gitPush, preflightCheck } from "./git.js";
import { findOrphanFiles, getGlobalSessionSet, writeManifest } from "./manifest.js";
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

export async function pushSessions(options?: { dryRun?: boolean; sessions?: SessionInfo[] }): Promise<PushResult> {
  if (!checkOpenCodeInstalled()) {
    throw new Error("opencode не найден. Установите opencode: https://opencode.ai");
  }

  const config = loadConfig();
  const result: PushResult = { exported: 0, skipped: 0, errors: 0 };

  await preflightCheck(config);
  ensureRepo(config.repo, config.localPath, config.branch);

  const sessions = options?.sessions ?? listSessions();
  const newCount = sessions.filter((s) => {
    if (!s.id) return false;
    const filePath = join(sessionsDir(config.localPath), s.projectId || "global", `${s.id}.json`);
    return isLocalNewer(s, filePath);
  }).length;

  console.log(`Push: ${sessions.length} сессий, ${newCount} новых/изменённых`);

  const toExport: SessionInfo[] = [];

  for (const session of sessions) {
    const projectId = session.projectId || "global";
    const sessionId = session.id;
    const filePath = join(sessionsDir(config.localPath), projectId, `${sessionId}.json`);

    if (!isLocalNewer(session, filePath) || !session.id) {
      result.skipped++;
      continue;
    }

    if (options?.dryRun) {
      log(`  [dry-run] Экспорт: ${session.title} (${sessionId})`);
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
    const localIds = new Set(sessions.filter((s) => s.id).map((s) => s.id));
    writeManifest(config.localPath, config.deviceName, localIds);

    const globalAlive = getGlobalSessionSet(config.localPath);
    const sessDir = sessionsDir(config.localPath);
    const orphans = findOrphanFiles(sessDir, globalAlive);

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

    if (result.exported > 0 || orphans.length > 0) {
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
