/**
 * @file push.ts
 * @description Экспорт локальных сессий в git-репозиторий.
 *
 * Алгоритм:
 *   1. Получить список всех локальных сессий (opencode session list)
 *   2. Для каждой сессии проверить — изменилась ли она с последнего экспорта
 *   3. Экспортировать изменившиеся сессии в JSON-файлы
 *   4. Commit + push в sync-репозиторий
 *
 * Incremental sync:
 *   Сессия экспортируется только если её time_updated больше,
 *   чем time_updated в уже существующем файле. Это избегает
 *   лишних операций и уменьшает размер git-истории.
 *
 * Безопасность:
 *   - Файлы сессий могут содержать фрагменты вашего кода
 *     (prompt, tool results). Убедитесь что sync-репозиторий
 *     PRIVATE и доступен только вам.
 *   - Маскируем URL репозитория в логах.
 */

import { loadConfig, sessionsDir } from "./config.js";
import {
  listSessions,
  exportSession,
  saveSessionToFile,
  isLocalNewer,
  type PushResult,
} from "./session.js";
import { ensureRepo, push as gitPush } from "./git.js";

// ─── Основная функция push ───────────────────────────────────────────────────

/**
 * Экспортирует локальные сессии и push'ит их в sync-репозиторий.
 *
 * @param options — опции push
 * @param options.dryRun — если true, только показать что было бы экспортировано
 * @returns Результат операции push
 */
export async function pushSessions(options?: { dryRun?: boolean }): Promise<PushResult> {
  const config = loadConfig();
  const result: PushResult = { exported: 0, skipped: 0, errors: 0 };

  // Убедимся что sync-репозиторий доступен
  ensureRepo(config.repo, config.localPath, config.branch);

  // Получаем список всех локальных сессий
  console.log("[push] Получение списка локальных сессий...");
  const sessions = listSessions();
  console.log(`[push] Найдено сессий: ${sessions.length}`);

  // Папка для сохранения сессий
  const sessDir = sessionsDir(config.localPath);

  // Обрабатываем каждую сессию
  for (const session of sessions) {
    const projectId = session.projectId || "global";
    const sessionId = session.id;

    // Определяем путь к файлу сессии
    const filePath = `${sessDir}/${projectId}/${sessionId}.json`;

    // Проверяем — нужно ли экспортировать (incremental)
    if (!isLocalNewer(session, filePath)) {
      result.skipped++;
      continue;
    }

    // Пропускаем сессии без projectId (защита от некорректных данных)
    if (!session.id) {
      result.skipped++;
      continue;
    }

    if (options?.dryRun) {
      console.log(`  [dry-run] Экспорт: ${session.title} (${sessionId})`);
      result.exported++;
      continue;
    }

    try {
      // Экспортируем сессию через opencode CLI
      const data = exportSession(sessionId);

      // exportSession вернёт null если JSON битый (большие сессии)
      if (!data) {
        result.skipped++;
        continue;
      }

      // Сохраняем в sync-репозиторий
      saveSessionToFile(data, config.localPath);

      result.exported++;
      console.log(`  ✓ ${session.title}`);
    } catch (err: any) {
      result.errors++;
      console.error(`  ✗ ${session.title}: ${err.message}`);
    }
  }

  // Push в remote (если не dry-run)
  if (!options?.dryRun && result.exported > 0) {
    console.log(`[push] Экспортировано: ${result.exported}, пропущено: ${result.skipped}`);
    gitPush(config.localPath, config.branch, config.deviceName);
  } else if (result.exported === 0) {
    console.log("[push] Все сессии актуальны, нет изменений для push");
  }

  return result;
}
