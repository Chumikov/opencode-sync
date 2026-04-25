#!/usr/bin/env node
/**
 * @file index.ts
 * @description CLI entry point для opencode-sync.
 *
 * Команды:
 *   opencode-sync init             — Настроить sync-репозиторий
 *   opencode-sync push             — Экспортировать сессии в git
 *   opencode-sync pull             — Импортировать сессии из git
 *   opencode-sync sync             — Pull + Push (полный цикл)
 *   opencode-sync status           — Показать текущую конфигурацию
 *
 * Флаги:
 *   --dry-run                      — Показать что будет сделано без выполнения
 *   --repo <url>                   — Переопределить URL репозитория
 *   --device <name>                — Переопределить имя устройства
 *
 * Примеры:
 *   opencode-sync init --repo git@github.com:user/sessions.git
 *   opencode-sync push
 *   opencode-sync pull --dry-run
 *   opencode-sync sync
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, CONFIG_FILE_PATH, DEFAULT_LOCAL_PATH } from "./config.js";
import { pushSessions } from "./push.js";
import { pullSessions } from "./pull.js";
import { isGitRepo } from "./git.js";

// ─── Версия из package.json ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// ─── CLI программа ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name("opencode-sync")
  .description("Git-based синхронизация сессий opencode между устройствами")
  .version(pkg.version);

// ─── Команда: init ───────────────────────────────────────────────────────────

program
  .command("init")
  .description("Настроить sync-репозиторий (первичная инициализация)")
  .requiredOption("--repo <url>", "URL git-репозитория (SSH или HTTPS)")
  .option("--device <name>", "Имя устройства", process.env.HOSTNAME || "unknown")
  .option("--path <dir>", "Локальный путь к клону", DEFAULT_LOCAL_PATH)
  .option("--branch <name>", "Ветка в репозитории", "main")
  .action(async (opts) => {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║     opencode-sync: инициализация             ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log();

    const config = {
      repo: opts.repo,
      deviceName: opts.device,
      localPath: opts.path,
      branch: opts.branch,
    };

    // Сохраняем конфигурацию
    saveConfig(config);

    console.log(`  Репозиторий:  ${opts.repo}`);
    console.log(`  Устройство:   ${opts.device}`);
    console.log(`  Локальный путь: ${opts.path}`);
    console.log(`  Ветка:        ${opts.branch}`);
    console.log();
    console.log("Готово! Теперь используйте:");
    console.log("  opencode-sync push   — экспортировать сессии");
    console.log("  opencode-sync pull   — импортировать сессии");
    console.log("  opencode-sync sync   — полный цикл (pull + push)");
  });

// ─── Команда: push ───────────────────────────────────────────────────────────

program
  .command("push")
  .description("Экспортировать локальные сессии в git-репозиторий")
  .option("--dry-run", "Показать что будет экспортировано без реального push")
  .action(async (opts) => {
    try {
      const result = await pushSessions({ dryRun: opts.dryRun });
      if (opts.dryRun) {
        console.log("\n[dry-run] Режим пробного запуска, изменения не применены");
      }
    } catch (err: any) {
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

// ─── Команда: pull ───────────────────────────────────────────────────────────

program
  .command("pull")
  .description("Импортировать сессии из git-репозитория")
  .option("--dry-run", "Показать что будет импортировано без реального импорта")
  .action(async (opts) => {
    try {
      const result = await pullSessions({ dryRun: opts.dryRun });
      if (opts.dryRun) {
        console.log("\n[dry-run] Режим пробного запуска, изменения не применены");
      }
    } catch (err: any) {
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

// ─── Команда: sync ───────────────────────────────────────────────────────────

program
  .command("sync")
  .description("Полный цикл синхронизации: pull + push")
  .option("--dry-run", "Показать что будет сделано без реальных изменений")
  .action(async (opts) => {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║     opencode-sync: полная синхронизация      ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log();

    try {
      // Шаг 1: Pull — подтягиваем сессии с других устройств
      console.log("── Шаг 1/2: Pull ──────────────────────────────");
      const pullResult = await pullSessions({ dryRun: opts.dryRun });

      console.log();

      // Шаг 2: Push — экспортируем локальные изменения
      console.log("── Шаг 2/2: Push ─────────────────────────────");
      const pushResult = await pushSessions({ dryRun: opts.dryRun });

      // Итоговый отчёт
      console.log();
      console.log("── Итог ──────────────────────────────────────");
      console.log(
        `  Импортировано: ${pullResult.imported} | ` +
          `Обновлено: ${pullResult.updated} | ` +
          `Ошибок: ${pullResult.errors}`,
      );
      console.log(
        `  Экспортировано: ${pushResult.exported} | ` +
          `Пропущено: ${pushResult.skipped} | ` +
          `Ошибок: ${pushResult.errors}`,
      );
    } catch (err: any) {
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

// ─── Команда: status ─────────────────────────────────────────────────────────

program
  .command("status")
  .description("Показать текущую конфигурацию и статус синхронизации")
  .action(() => {
    try {
      const config = loadConfig();

      console.log("╔══════════════════════════════════════════════╗");
      console.log("║     opencode-sync: статус                    ║");
      console.log("╚══════════════════════════════════════════════╝");
      console.log();
      console.log(`  Конфиг:        ${CONFIG_FILE_PATH}`);
      console.log(`  Репозиторий:   ${config.repo}`);
      console.log(`  Устройство:    ${config.deviceName}`);
      console.log(`  Локальный путь: ${config.localPath}`);
      console.log(`  Ветка:         ${config.branch}`);
      console.log(`  Repo exists:   ${isGitRepo(config.localPath) ? "да" : "нет"}`);
    } catch (err: any) {
      console.error(`[error] ${err.message}`);
      console.error();
      console.error("Запустите opencode-sync init --repo <url> для настройки");
      process.exit(1);
    }
  });

// ─── Запуск ──────────────────────────────────────────────────────────────────

program.parse(process.argv);
