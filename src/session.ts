/**
 * @file session.ts
 * @description Работа с сессиями opencode: чтение, экспорт, импорт.
 *
 * Два источника данных:
 *   1. SQLite база opencode (прямое чтение) — для получения списка ВСЕХ сессий
 *      из всех проектов. CLI-команда `opencode session list` фильтрует по текущему
 *      проекту, поэтому прямой доступ к БД — единственный надёжный способ.
 *
 *   2. opencode CLI — для экспорта/импорта отдельных сессий.
 *      `opencode export <id>` и `opencode import <file>` работают глобально.
 *
 * Безопасность:
 *   - SQLite открыт в режиме READ-ONLY (no mutable API)
 *   - CLI вызывается через execFileSync (без shell)
 *   - Никакие данные сессий не логируются
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";

// ─── Пути к БД opencode ──────────────────────────────────────────────────────

/**
 * Путь к SQLite БД opencode.
 * Следуем XDG: $XDG_DATA_HOME/opencode/opencode.db
 * Можно переопределить через OPENCODE_DB.
 */
function getOpenCodeDbPath(): string {
  if (process.env.OPENCODE_DB) {
    const envPath = process.env.OPENCODE_DB;
    // Если :memory: — fallback на стандартный путь
    if (envPath === ":memory:") {
      return join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "opencode",
        "opencode.db",
      );
    }
    return envPath;
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "opencode.db",
  );
}

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Краткая информация о сессии из SQLite */
export interface SessionInfo {
  /** Уникальный ID сессии (ULID) */
  id: string;

  /** Заголовок сессии */
  title: string;

  /** ID проекта (хеш первого git-коммита или "global") */
  projectId: string;

  /** Рабочая директория сессии */
  directory: string;

  /** Unix-метка создания (мс) */
  created: number;

  /** Unix-метка последнего обновления (мс) */
  updated: number;
}

/**
 * Полные экспортированные данные сессии.
 * Структура, возвращаемая `opencode export <sessionID>`.
 *
 * Реальный формат от opencode:
 *   { info: { id, projectID, time: { created, updated }, ... }, messages: [...] }
 */
export interface SessionExport {
  /** Метаданные сессии (ключ "info" в JSON) */
  info: {
    id: string;
    /** Замечание: opencode использует "projectID" (с большой D) */
    projectID: string;
    title: string;
    directory: string;
    /** Время вложено в объект time */
    time: {
      created: number;
      updated: number;
    };
    [key: string]: unknown;
  };

  /** Сообщения в сессии */
  messages: Array<{
    info: { id: string; role: string; [key: string]: unknown };
    parts: Array<{ type: string; [key: string]: unknown }>;
  }>;
}

/**
 * Безопасное извлечение projectID из SessionExport.
 * Обрабатывает оба варианта: info.projectID и info.projectId.
 */
export function getProjectId(data: SessionExport): string {
  return (data.info as any).projectID || (data.info as any).projectId || "global";
}

/**
 * Безопасное извлечение time_updated из SessionExport.
 */
function getUpdated(data: SessionExport): number {
  if (data.info.time?.updated) return data.info.time.updated;
  return (data.info as any).updated || 0;
}

/**
 * Безопасное извлечение time_created из SessionExport.
 */
function getCreated(data: SessionExport): number {
  if (data.info.time?.created) return data.info.time.created;
  return (data.info as any).created || 0;
}

/** Результат операции push */
export interface PushResult {
  exported: number;
  skipped: number;
  errors: number;
}

/** Результат операции pull */
export interface PullResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
}

// ─── CLI утилиты ─────────────────────────────────────────────────────────────

/** Путь к бинарнику opencode */
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

/**
 * Безопасно вызывает opencode CLI-команду через execFileSync.
 * Без shell — нет риска инъекций.
 *
 * @param args — аргументы командной строки opencode
 * @returns stdout команды
 * @throws Error при ненулевом коде возврата
 */
function runOpenCode(args: string[]): string {
  try {
    const result = execFileSync(OPENCODE_BIN, args, {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024, // 50 МБ для больших сессий
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    const msg = stderr || err.message;
    throw new Error(`opencode ${args.join(" ")}: ${msg}`);
  }
}

// ─── Получение списка сессий (прямой доступ к SQLite) ────────────────────────

/**
 * Получает список ВСЕХ сессий из opencode SQLite базы.
 *
 * Читаем напрямую из БД, а не через CLI, потому что:
 *   - `opencode session list` фильтрует по текущему проекту
 *   - Нам нужны все сессии со всех проектов для полного sync
 *
 * БД открывается в READ-ONLY режиме для безопасности:
 *   - Никаких случайных изменений opencode данных
 *
 * @returns Массив объектов SessionInfo (отсортирован по updated DESC)
 */
export function listSessions(): SessionInfo[] {
  const dbPath = getOpenCodeDbPath();

  if (!existsSync(dbPath)) {
    console.warn(`[session] БД opencode не найдена: ${dbPath}`);
    return [];
  }

  // Открываем в read-only режиме (флаг 1 = SQLITE_OPEN_READONLY)
  const db = new Database(dbPath, { readonly: true });

  try {
    // Запрашиваем все сессии, исключая архивные (time_archived IS NULL)
    const rows = db
      .prepare(
        `SELECT
           id,
           title,
           project_id   AS projectId,
           directory,
           time_created AS created,
           time_updated AS updated
         FROM session
         WHERE time_archived IS NULL
         ORDER BY time_updated DESC`,
      )
      .all() as SessionInfo[];

    return rows;
  } finally {
    db.close();
  }
}

/**
 * Возвращает Map<sessionId, SessionInfo> для быстрого поиска по ID.
 * Используется при pull для определения какие сессии уже есть локально.
 */
export function getSessionMap(): Map<string, SessionInfo> {
  const sessions = listSessions();
  const map = new Map<string, SessionInfo>();
  for (const s of sessions) {
    map.set(s.id, s);
  }
  return map;
}

// ─── Экспорт сессии ──────────────────────────────────────────────────────────

/**
 * Экспортирует одну сессию в JSON через `opencode export`.
 *
 * Некоторые сессии могут быть слишком велики или содержать
 * бинарные данные, из-за чего JSON получается битым.
 * В таких случаях функция вернёт null.
 *
 * @param sessionId — ID сессии для экспорта
 * @returns SessionExport или null если JSON битый
 */
export function exportSession(sessionId: string): SessionExport | null {
  try {
    const stdout = runOpenCode(["export", sessionId]);
    return JSON.parse(stdout) as SessionExport;
  } catch (err: any) {
    // Битый JSON — распространённый кейс для больших сессий
    if (err.message.includes("JSON")) {
      console.warn(`  ⚠ ${sessionId}: битый JSON от opencode export, пропускаем`);
      return null;
    }
    throw err;
  }
}

/**
 * Сохраняет экспортированную сессию в файл в sync-репозитории.
 *
 * Структура: sessions/{project_id}/{session_id}.json
 * Каждый файл — одна сессия. Это обеспечивает:
 *   - Гранулярные git-коммиты (один файл = одна сессия)
 *   - Минимум merge-конфликтов (разные сессии = разные файлы)
 *
 * @param data     — экспортированные данные сессии
 * @param basePath — корневая директория sync-репозитория
 * @returns Путь к сохранённому файлу
 */
export function saveSessionToFile(data: SessionExport, basePath: string): string {
  const projectId = getProjectId(data);
  const sessionId = data.info.id;
  const filePath = join(basePath, "sessions", projectId, `${sessionId}.json`);

  mkdirSync(dirname(filePath), { recursive: true });

  // Форматированный JSON для читаемости в git diff
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");

  return filePath;
}

// ─── Чтение сессии из файла ──────────────────────────────────────────────────

/**
 * Читает JSON-файл сессии из sync-репозитория.
 *
 * @param filePath — абсолютный путь к файлу
 * @returns SessionExport или null если файл повреждён
 */
export function readSessionFromFile(filePath: string): SessionExport | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionExport;
  } catch {
    console.warn(`[sync] Не удалось прочитать файл сессии: ${filePath}`);
    return null;
  }
}

// ─── Импорт сессии ───────────────────────────────────────────────────────────

/**
 * Импортирует сессию из JSON-файла через `opencode import`.
 *
 * @param filePath — путь к JSON-файлу сессии
 * @returns true если импорт успешен
 */
export function importSession(filePath: string): boolean {
  try {
    runOpenCode(["import", filePath]);
    return true;
  } catch (err: any) {
    console.error(`[sync] Ошибка импорта ${filePath}: ${err.message}`);
    return false;
  }
}

// ─── Сравнение версий ────────────────────────────────────────────────────────

/**
 * Проверяет, новее ли локальная сессия чем версия в файле.
 *
 * Используется при push: экспортировать только если
 * локальная версия изменилась (incremental sync).
 *
 * @param local    — информация о локальной сессии
 * @param filePath — путь к файлу в sync-репозитории
 * @returns true если локальная версия новее (нужно обновить файл)
 */
export function isLocalNewer(local: SessionInfo, filePath: string): boolean {
  if (!existsSync(filePath)) return true;

  const fileData = readSessionFromFile(filePath);
  if (!fileData) return true;

  return local.updated > getUpdated(fileData);
}

/**
 * Проверяет, новее ли файловая версия чем локальная сессия.
 *
 * Используется при pull: импортировать только если
 * remote-версия новее (last-write-wins).
 *
 * @param filePath — путь к файлу в sync-репозитории
 * @param localMap — Map локальных сессий для быстрого поиска
 * @returns true если remote новее (нужно импортировать)
 */
export function isRemoteNewer(
  filePath: string,
  localMap: Map<string, SessionInfo>,
): boolean {
  const fileData = readSessionFromFile(filePath);
  if (!fileData) return false;

  const sessionId = fileData.info.id;
  const localSession = localMap.get(sessionId);

  // Нет локально — нужно импортировать
  if (!localSession) return true;

  // Импортируем только если remote новее
  return fileData.info.time.updated > localSession.updated;
}
