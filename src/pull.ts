/**
 * @file pull.ts
 * @description Импорт сессий из git-репозитория в локальную opencode БД.
 *
 * Алгоритм:
 *   1. git pull — подтягиваем последние изменения из remote
 *   2. Получить список локальных сессий (opencode session list)
 *   3. Найти все JSON-файлы в sync-репозитории
 *   4. Для каждого файла:
 *      - Если сессии нет локально → импортировать
 *      - Если файл новее локальной версии → обновить (ре-импорт)
 *      - Если локальная версия новее → пропустить
 *   5. Вывести отчёт
 *
 * Разрешение конфликтов (last-write-wins):
 *   Сравниваем поле time_updated в JSON-файле с time_updated
 *   локальной сессии. Если remote новее — импортируем,
 *   если локальная новее — пропускаем (будет запушена при push).
 *
 * Безопасность:
 *   - `opencode import` создаёт новую сессию если ID не существует,
 *     или обновляет существующую
 *   - Проверяем целостность JSON перед импортом
 *   - Логируем каждую операцию для аудита
 */

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { loadConfig, sessionsDir } from "./config.js";
import {
  getSessionMap,
  readSessionFromFile,
  importSession,
  isRemoteNewer,
  type PullResult,
} from "./session.js";
import { pull as gitPull, ensureRepo } from "./git.js";

// ─── Скан файловой системы ───────────────────────────────────────────────────

/**
 * Рекурсивно находит все JSON-файлы в директории.
 *
 * @param dir — корневая директория для поиска
 * @returns Массив абсолютных путей к JSON-файлам
 */
function findJsonFiles(dir: string): string[] {
  const results: string[] = [];

  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return results;
  }

  /**
   * Рекурсивный обход директорий.
   * Структура: sessions/{project_id}/{session_id}.json
   */
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

// ─── Основная функция pull ───────────────────────────────────────────────────

/**
 * Подтягивает сессии из sync-репозитория и импортирует их.
 *
 * @param options — опции pull
 * @param options.dryRun — если true, только показать что было бы импортировано
 * @returns Результат операции pull
 */
export async function pullSessions(options?: { dryRun?: boolean }): Promise<PullResult> {
  const config = loadConfig();
  const result: PullResult = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  // Убедимся что sync-репозиторий доступен
  ensureRepo(config.repo, config.localPath, config.branch);

  // Подтягиваем последние изменения
  console.log("[pull] Подтягивание изменений из remote...");
  try {
    gitPull(config.localPath, config.branch);
  } catch (err: any) {
    console.error(`[pull] Ошибка при git pull: ${err.message}`);
    console.error("[pull] Продолжаем с локальной копией");
  }

  // Получаем Map локальных сессий для быстрого поиска
  console.log("[pull] Загрузка локальных сессий...");
  const localMap = getSessionMap();
  console.log(`[pull] Локальных сессий: ${localMap.size}`);

  // Находим все JSON-файлы сессий
  const sessDir = sessionsDir(config.localPath);
  const files = findJsonFiles(sessDir);
  console.log(`[pull] Файлов в репозитории: ${files.length}`);

  // Обрабатываем каждый файл
  for (const filePath of files) {
    // Читаем файл чтобы проверить целостность и получить метаданные
    const fileData = readSessionFromFile(filePath);
    if (!fileData) {
      result.errors++;
      continue;
    }

    const sessionId = fileData.info.id;
    const sessionTitle = fileData.info.title || sessionId;
    const isLocal = localMap.has(sessionId);

    // Проверяем — нужно ли импортировать
    if (!isRemoteNewer(filePath, localMap)) {
      result.skipped++;
      continue;
    }

    if (options?.dryRun) {
      const action = isLocal ? "обновить" : "импорт";
      console.log(`  [dry-run] ${action}: ${sessionTitle} (${sessionId})`);
      if (isLocal) result.updated++;
      else result.imported++;
      continue;
    }

    // Импортируем
    const success = importSession(filePath);
    if (success) {
      if (isLocal) {
        result.updated++;
        console.log(`  ↑ ${sessionTitle} (обновлено)`);
      } else {
        result.imported++;
        console.log(`  + ${sessionTitle} (новая)`);
      }
    } else {
      result.errors++;
    }
  }

  // Итоговый отчёт
  console.log(
    `\n[pull] Итого: импортировано ${result.imported}, ` +
      `обновлено ${result.updated}, ` +
      `пропущено ${result.skipped}, ` +
      `ошибок ${result.errors}`,
  );

  return result;
}
