import { join } from "node:path";
import { loadConfig, sessionsDir } from "./config.js";
import {
  listSessions,
  exportSessionAsync,
  saveSessionToFile,
  isLocalNewer,
  type PushResult,
  type SessionInfo,
} from "./session.js";
import { ensureRepo, push as gitPush } from "./git.js";
import { log, promisePool, EXPORT_CONCURRENCY, withLockAsync } from "./util.js";

export async function pushSessions(options?: {
  dryRun?: boolean;
  sessions?: SessionInfo[];
}): Promise<PushResult> {
  const config = loadConfig();
  const result: PushResult = { exported: 0, skipped: 0, errors: 0 };

  ensureRepo(config.repo, config.localPath, config.branch);

  const sessions = options?.sessions ?? listSessions();
  log(`[push] Найдено сессий: ${sessions.length}`);

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
    const exportResults = await promisePool(toExport, EXPORT_CONCURRENCY, async (session) => {
      try {
        const data = await exportSessionAsync(session.id);
        if (!data) return { kind: "skipped" as const };
        saveSessionToFile(data, config.localPath);
        log(`  ✓ ${session.title}`);
        return { kind: "exported" as const };
      } catch (err: any) {
        log(`  ✗ ${session.title}: ${err.message}`);
        return { kind: "error" as const };
      }
    });

    for (const r of exportResults) {
      if (r.kind === "exported") result.exported++;
      else if (r.kind === "skipped") result.skipped++;
      else if (r.kind === "error") result.errors++;
    }
  }

  if (!options?.dryRun && result.exported > 0) {
    log(`[push] Экспортировано: ${result.exported}, пропущено: ${result.skipped}`);
    await withLockAsync(config.localPath, () => gitPush(config.localPath, config.branch, config.deviceName));
  } else if (result.exported === 0) {
    log("[push] Все сессии актуальны, нет изменений для push");
  }

  return result;
}
