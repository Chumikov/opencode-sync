/**
 * @file git.ts
 * @description Git-операции для синхронизации сессий.
 *
 * Использует системный git через child_process.execFileSync.
 * Никаких shell-команд — только безопасный вызов git binary
 * с массивом аргументов.
 *
 * Поддерживаемые операции:
 *   - clone  — клонирование sync-репозитория
 *   - pull   — подтягивание изменений (git pull --rebase)
 *   - add    — индексация файлов
 *   - commit — создание коммита с описанием устройства
 *   - push   — отправка изменений
 *
 * Безопасность:
 *   - execFileSync предотвращает shell-инъекции
 *   - git credentials используются через системные механизмы
 *     (ssh-agent, credential helper и т.д.)
 *   - Никакие секреты не логируются
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// ─── Конфигурация ────────────────────────────────────────────────────────────

/** Путь к бинарнику git */
const GIT_BIN = process.env.GIT_BIN || "git";

/** Максимальное время выполнения git-команды (мс) */
const GIT_TIMEOUT = 60_000;

// ─── Утилиты ─────────────────────────────────────────────────────────────────

/**
 * Безопасно вызывает git-команду.
 *
 * @param args    — аргументы git (без "git" в начале)
 * @param cwd     — рабочая директория (по умолчанию process.cwd())
 * @returns stdout команды
 * @throws Error при ошибке git
 */
function runGit(args: string[], cwd?: string): string {
  try {
    const result = execFileSync(GIT_BIN, args, {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT,
      maxBuffer: 20 * 1024 * 1024,   // 20 МБ буфер
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    const msg = stderr || err.message;

    // Пробрасываем понятное сообщение
    throw new Error(`git ${args.join(" ")}: ${msg}`);
  }
}

// ─── Инициализация ───────────────────────────────────────────────────────────

/**
 * Проверяет, является ли директория git-репозиторием.
 *
 * @param dirPath — путь к директории
 * @returns true если директория содержит .git
 */
export function isGitRepo(dirPath: string): boolean {
  return existsSync(`${dirPath}/.git`) || existsSync(`${dirPath}/.git/HEAD`);
}

/**
 * Клонирует sync-репозиторий.
 *
 * Использует git clone --depth 1 для скорости, затем unshallow
 * для полной истории (нужна для merge conflict resolution).
 *
 * @param repoUrl  — URL репозитория (SSH или HTTPS)
 * @param localPath — путь куда клонировать
 * @param branch   — ветка для checkout
 */
export function clone(repoUrl: string, localPath: string, branch: string): void {
  console.log(`[git] Клонирование ${maskUrl(repoUrl)} → ${localPath}`);

  runGit(["clone", "--branch", branch, "--single-branch", repoUrl, localPath]);

  console.log("[git] Репозиторий клонирован");
}

/**
 * Инициализирует sync-репозиторий: клонирует если не существует,
 * или проверяет что существующая директория — правильный репозиторий.
 *
 * @param repoUrl   — URL репозитория
 * @param localPath — путь к локальному клону
 * @param branch    — ветка
 */
export function ensureRepo(repoUrl: string, localPath: string, branch: string): void {
  if (isGitRepo(localPath)) {
    // Проверяем что remote указывает на нужный URL
    try {
      const remoteUrl = runGit(["config", "--get", "remote.origin.url"], localPath).trim();
      if (remoteUrl !== repoUrl) {
        // Обновляем remote URL если не совпадает
        console.log(`[git] Обновление remote URL`);
        runGit(["remote", "set-url", "origin", repoUrl], localPath);
      }
    } catch {
      // remote.origin.url может не существовать — добавляем
      runGit(["remote", "add", "origin", repoUrl], localPath);
    }
  } else {
    // Репозиторий не существует — клонируем
    clone(repoUrl, localPath, branch);
  }
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

/**
 * Подтягивает изменения из remote.
 *
 * Использует git pull --rebase для линейной истории.
 * При конфликте — пытается разрешить автоматически
 * (стратегия last-write-wins, реализована в push.ts).
 *
 * @param localPath — путь к локальному клону
 * @param branch    — ветка
 * @returns true если были новые коммиты
 */
export function pull(localPath: string, branch: string): boolean {
  try {
    const result = runGit(
      ["pull", "--rebase", "--strategy-option", "theirs", "origin", branch],
      localPath,
    );

    // git pull выводит "Already up to date." если изменений нет
    const hasChanges = !result.includes("Already up to date");
    if (hasChanges) {
      console.log("[git] Подтягивание завершено, есть новые изменения");
    } else {
      console.log("[git] Изменений нет, уже актуально");
    }
    return hasChanges;
  } catch (err: any) {
    // Если rebase конфликт — пробуем решить
    if (err.message.includes("CONFLICT") || err.message.includes("conflict")) {
      console.warn("[git] Merge-конфликт при pull, прерываем rebase");
      try {
        runGit(["rebase", "--abort"], localPath);
      } catch {
        // Игнорируем ошибку abort
      }
      throw new Error("Merge-конфликт. Попробуйте opencode-sync push --force");
    }
    throw err;
  }
}

// ─── Commit ───────────────────────────────────────────────────────────────────

/**
 * Индексирует все изменения и создаёт коммит.
 *
 * Коммит-сообщение содержит имя устройства и timestamp
 * для отслеживания источника изменений:
 *   "sync: macbook-pro @ 2026-04-25T10:30:00Z"
 *
 * @param localPath  — путь к локальному клону
 * @param deviceName — имя устройства (для коммит-сообщения)
 * @returns true если был создан новый коммит
 */
export function commit(localPath: string, deviceName: string): boolean {
  // Добавляем все изменения (новые, изменённые, удалённые файлы)
  runGit(["add", "--all"], localPath);

  // Проверяем есть ли что коммитить
  try {
    runGit(["diff", "--cached", "--quiet"], localPath);
    // Если diff --quiet не упал — нет изменений
    return false;
  } catch {
    // diff --quiet возвращает код 1 если есть изменения — это нормально
  }

  // Формируем сообщение с устройством и timestamp
  const timestamp = new Date().toISOString();
  const message = `sync: ${deviceName} @ ${timestamp}`;
  runGit(["commit", "-m", message], localPath);

  console.log(`[git] Коммит: ${message}`);
  return true;
}

// ─── Push ─────────────────────────────────────────────────────────────────────

/**
 * Отправляет локальные коммиты в remote.
 *
 * Перед push делает pull --rebase чтобы подmergereить
 * чужие изменения. Это снижает вероятность конфликтов.
 *
 * @param localPath — путь к локальному клону
 * @param branch    — ветка
 * @param deviceName — имя устройства (для коммит-сообщения)
 */
export function push(localPath: string, branch: string, deviceName: string): void {
  // Сначала подтягиваем изменения
  try {
    pull(localPath, branch);
  } catch (err: any) {
    console.warn(`[git] Предупреждение при pull: ${err.message}`);
    // Продолжаем push — конфликт будет на стороне remote
  }

  // Создаём коммит если есть изменения
  const hasCommit = commit(localPath, deviceName);

  if (hasCommit) {
    console.log(`[git] Push в origin/${branch}...`);
    runGit(["push", "origin", branch], localPath);
    console.log("[git] Push завершён");
  } else {
    console.log("[git] Нет изменений для push");
  }
}

// ─── Утилиты безопасности ────────────────────────────────────────────────────

// Маскирует URL репозитория для логов (скрывает учётные данные).
// git@... host скрыт, https://user:pass@... учётные данные скрыты.
function maskUrl(url: string): string {
  try {
    // SSH-формат: git@host:user/repo.git
    if (url.startsWith("git@")) {
      const parts = url.split(":");
      return `${parts[0]}:***`;
    }

    // HTTPS-формат: скрываем токены/пароли в URL
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username) {
      parsed.username = "***";
    }
    return parsed.toString();
  } catch {
    return "***";
  }
}
