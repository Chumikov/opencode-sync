/**
 * @file config.ts
 * @description Конфигурация opencode-sync.
 *
 * Читает настройки из файла ~/.config/opencode/sync.json или
 * из переменных окружения OPENCODE_SYNC_*. Переменные окружения
 * имеют приоритет над файлом конфигурации.
 *
 * Пути следуют XDG Base Directory Specification:
 *   - Config:  $XDG_CONFIG_HOME/opencode/sync.json
 *   - Storage: $XDG_DATA_HOME/opencode-sync/
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

// ─── XDG-пути по умолчанию ──────────────────────────────────────────────────

/**
 * Базовая директория для данных XDG.
 * $XDG_DATA_HOME или ~/.local/share
 */
const xdgDataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");

/**
 * Базовая директория для конфигурации XDG.
 * $XDG_CONFIG_HOME или ~/.config
 */
const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

// ─── Типы ────────────────────────────────────────────────────────────────────

/** Конфигурация opencode-sync, хранимая в sync.json */
export interface SyncConfig {
  /** URL git-репозитория для синхронизации (SSH или HTTPS) */
  repo: string;

  /** Имя текущего устройства (используется в коммит-сообщениях) */
  deviceName: string;

  /** Локальный путь к клону sync-репозитория (абсолютный) */
  localPath: string;

  /** Ветка в sync-репозитории */
  branch: string;
}

// ─── Значения по умолчанию ───────────────────────────────────────────────────

/** Путь к файлу конфигурации */
export const CONFIG_FILE_PATH = join(xdgConfigHome, "opencode", "sync.json");

/** Путь к локальному клону sync-репозитория по умолчанию */
export const DEFAULT_LOCAL_PATH = join(xdgDataHome, "opencode-sync");

/** Путь к файлу лога синхронизации */
export const SYNC_LOG_PATH = join(DEFAULT_LOCAL_PATH, "sync.log");

// ─── Чтение конфигурации ─────────────────────────────────────────────────────

/**
 * Загружает конфигурацию opencode-sync.
 *
 * Приоритет источников (от высокого к низкому):
 *   1. Переменные окружения OPENCODE_SYNC_*
 *   2. Файл ~/.config/opencode/sync.json
 *   3. Значения по умолчанию
 *
 * @returns Скомбинированная конфигурация
 * @throws Error если repo не указан ни в файле, ни через env
 */
export function loadConfig(): SyncConfig {
  let fileConfig: Partial<SyncConfig> = {};
  if (existsSync(CONFIG_FILE_PATH)) {
    try {
      const raw = readFileSync(CONFIG_FILE_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        fileConfig = parsed;
      } else {
        console.warn(`[sync] Некорректная структура в ${CONFIG_FILE_PATH}, используем env-переменные`);
      }
    } catch {
      console.warn(`[sync] Не удалось прочитать ${CONFIG_FILE_PATH}, используем env-переменные`);
    }
  }

  const repo = process.env.OPENCODE_SYNC_REPO || fileConfig.repo;
  if (!repo || typeof repo !== "string") {
    throw new Error(
      `Не указан git-репозиторий.\n  Установите OPENCODE_SYNC_REPO или добавьте "repo" в ${CONFIG_FILE_PATH}`,
    );
  }

  const deviceName = process.env.OPENCODE_SYNC_DEVICE || fileConfig.deviceName || hostname();

  const localPath = resolve(process.env.OPENCODE_SYNC_PATH || fileConfig.localPath || DEFAULT_LOCAL_PATH);

  const branch = process.env.OPENCODE_SYNC_BRANCH || fileConfig.branch || "main";

  return { repo, deviceName, localPath, branch };
}

// ─── Сохранение конфигурации ─────────────────────────────────────────────────

/**
 * Сохраняет конфигурацию в файл.
 * Создаёт родительские директории при необходимости.
 */
export function saveConfig(config: SyncConfig): void {
  const dir = join(xdgConfigHome, "opencode");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG_FILE_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  chmodSync(CONFIG_FILE_PATH, 0o600);
  console.log(`[sync] Конфигурация сохранена в ${CONFIG_FILE_PATH}`);
}

// ─── Структура директорий sync-репозитория ───────────────────────────────────

/**
 * Возвращает путь к папке сессий внутри sync-репозитория.
 * Сессии хранятся по одному файлу: sessions/{project_id}/{session_id}.json
 */
export function sessionsDir(localPath: string): string {
  return join(localPath, "sessions");
}
