#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig, CONFIG_FILE_PATH } from "./config.js";
import { pushSessions } from "./push.js";
import { pullSessions } from "./pull.js";
import { isGitRepo, maskUrl } from "./git.js";
import { listSessions } from "./session.js";
import { printBanner, VERSION } from "./banner.js";
import { runSetup, SetupCancelledError } from "./setup.js";

const program = new Command();

program
  .name("opencode-sync")
  .version(VERSION)
  .addHelpText("before", () => {
    printBanner();
    return "";
  });

const helpText = `opencode-sync — Git-based синхронизация сессий opencode

Команды:
  setup      Первичная настройка (TUI)
  push       Экспортировать сессии в git
  pull       Импортировать сессии из git
  sync       Полный цикл: pull + push
  status     Показать текущую конфигурацию

Флаги:
  --dry-run  Показать что будет сделано, без изменений

Автосинхронизация:
  При setup в ~/.bashrc или ~/.zshrc добавляется функция,
  которая автоматически подтягивает сессии перед запуском
  opencode и отправляет после завершения.

Переменные окружения:
  OPENCODE_SYNC_REPO      URL git-репозитория
  OPENCODE_SYNC_DEVICE    Имя устройства
  OPENCODE_SYNC_PATH      Локальный путь к клону
  OPENCODE_BIN            Путь к бинарнику opencode
  OPENCODE_DB             Путь к SQLite базе opencode

Chumikov Sec — https://t.me/chumikovsec`;

program.addHelpText("after", "\n" + helpText);

program
  .command("setup")
  .description("Первичная настройка (TUI)")
  .action(async () => {
    printBanner();
    try {
      await runSetup();
    } catch (err: any) {
      if (err instanceof SetupCancelledError) {
        process.exit(0);
      }
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("push")
  .description("Экспортировать локальные сессии в git-репозиторий")
  .option("--dry-run", "Показать что будет экспортировано без реального push")
  .action(async (opts) => {
    try {
      await pushSessions({ dryRun: opts.dryRun });
      if (opts.dryRun) {
        console.log("\n[dry-run] Режим пробного запуска, изменения не применены");
      }
    } catch (err: any) {
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("pull")
  .description("Импортировать сессии из git-репозитория")
  .option("--dry-run", "Показать что будет импортировано без реального импорта")
  .action(async (opts) => {
    try {
      await pullSessions({ dryRun: opts.dryRun });
      if (opts.dryRun) {
        console.log("\n[dry-run] Режим пробного запуска, изменения не применены");
      }
    } catch (err: any) {
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("sync")
  .description("Полный цикл синхронизации: pull + push")
  .option("--dry-run", "Показать что будет сделано без реальных изменений")
  .action(async (opts) => {
    try {
      console.log("── Sync ─────────────────────────────────────");
      console.log();

      console.log("[pull]");
      const pullResult = await pullSessions({
        dryRun: opts.dryRun,
      });

      console.log();

      console.log("[push]");
      const sessions = listSessions();
      const pushResult = await pushSessions({
        dryRun: opts.dryRun,
        sessions,
      });

      console.log();
      console.log("── Итог ─────────────────────────────────────");

      const pullParts = [];
      if (pullResult.imported > 0) pullParts.push(`${pullResult.imported} импорт`);
      if (pullResult.updated > 0) pullParts.push(`${pullResult.updated} обновлено`);
      if (pullResult.deleted > 0) pullParts.push(`${pullResult.deleted} удалено`);
      if (pullResult.errors > 0) pullParts.push(`${pullResult.errors} ошибок`);

      const pushParts = [];
      if (pushResult.exported > 0) pushParts.push(`${pushResult.exported} экспорт`);
      if (pushResult.errors > 0) pushParts.push(`${pushResult.errors} ошибок`);

      console.log(
        `  [pull] ${pullParts.length > 0 ? pullParts.join(", ") : "нет изменений"}`,
      );
      console.log(
        `  [push] ${pushParts.length > 0 ? pushParts.join(", ") : "нет изменений"}`,
      );
    } catch (err: any) {
      console.error(`\n[error] ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Показать текущую конфигурацию и статус синхронизации")
  .action(() => {
    try {
      const config = loadConfig();

      console.log(`  Конфиг:        ${CONFIG_FILE_PATH}`);
      console.log(`  Репозиторий:   ${maskUrl(config.repo)}`);
      console.log(`  Устройство:    ${config.deviceName}`);
      console.log(`  Локальный путь: ${config.localPath}`);
      console.log(`  Ветка:         ${config.branch}`);
      console.log(`  Repo exists:   ${isGitRepo(config.localPath) ? "да" : "нет"}`);
    } catch (err: any) {
      console.error(`[error] ${err.message}`);
      console.error();
      console.error("Запустите opencode-sync setup для настройки");
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
