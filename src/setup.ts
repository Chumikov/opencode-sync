import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import * as clack from "@clack/prompts";
import { CONFIG_FILE_PATH, DEFAULT_LOCAL_PATH, saveConfig } from "./config.js";
import {
  checkRepoAccess,
  clone,
  cloneAll,
  initEmptyRepo,
  isGitRepo,
  listBranches,
  listRemoteBranches,
  maskUrl,
} from "./git.js";
import { checkOpenCodeInstalled } from "./session.js";
import { installShellFunction } from "./shell.js";

class SetupCancelledError extends Error {
  constructor() {
    super("Настройка отменена");
    this.name = "SetupCancelledError";
  }
}

class SetupFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupFailedError";
  }
}

export { SetupCancelledError, SetupFailedError };

const SETUP_INFO = `Для синхронизации нужен приватный git-репозиторий.
Он хранит экспортированные сессии в виде JSON-файлов.
Репозиторий должен быть приватным — файлы содержат
ваши промпты, фрагменты кода и результаты работы.

Создайте репозиторий на GitHub, затем укажите его URL.`;

export async function runSetup(): Promise<void> {
  if (!checkOpenCodeInstalled()) {
    clack.outro("opencode не найден. Установите opencode: https://opencode.ai");
    throw new SetupFailedError("opencode не найден");
  }

  if (existsSync(CONFIG_FILE_PATH)) {
    const shouldReconfigure = await clack.confirm({
      message: "Конфигурация уже существует. Перенастроить?",
      initialValue: false,
    });

    if (clack.isCancel(shouldReconfigure) || !shouldReconfigure) {
      clack.cancel("Настройка отменена");
      throw new SetupCancelledError();
    }
  }

  clack.note(SETUP_INFO, "Git-репозиторий");

  let repoUrl = await clack.text({
    message: "URL git-репозитория (SSH или HTTPS)",
    placeholder: "git@github.com:user/sessions.git",
    validate: (value) => {
      const v = value ?? "";
      if (!v.trim()) return "Укажите URL репозитория";
      if (!v.startsWith("git@") && !v.startsWith("https://") && !v.startsWith("http://") && !v.startsWith("ssh://")) {
        return "URL должен начинаться с git@, https://, http:// или ssh://";
      }
    },
  });

  if (clack.isCancel(repoUrl)) {
    clack.cancel("Настройка отменена");
    throw new SetupCancelledError();
  }

  while (true) {
    const s = clack.spinner();
    s.start("Проверяю доступ к репозиторию...");

    const access = checkRepoAccess(String(repoUrl));

    if (access.ok) {
      s.stop("Доступ подтверждён");
      break;
    }

    s.stop();
    clack.log.error(access.error);
    clack.note(access.hint, "Как исправить");

    const choice = await clack.select({
      message: "Что делать дальше?",
      options: [
        { value: "retry", label: "Повторить проверку" },
        { value: "change", label: "Изменить URL" },
        { value: "cancel", label: "Отмена" },
      ],
    });

    if (clack.isCancel(choice) || choice === "cancel") {
      clack.cancel("Настройка отменена");
      throw new SetupCancelledError();
    }

    if (choice === "change") {
      const newUrl = await clack.text({
        message: "URL git-репозитория (SSH или HTTPS)",
        placeholder: "git@github.com:user/sessions.git",
        validate: (value) => {
          const v = value ?? "";
          if (!v.trim()) return "Укажите URL репозитория";
          if (
            !v.startsWith("git@") &&
            !v.startsWith("https://") &&
            !v.startsWith("http://") &&
            !v.startsWith("ssh://")
          ) {
            return "URL должен начинаться с git@, https://, http:// или ssh://";
          }
        },
      });

      if (clack.isCancel(newUrl)) {
        clack.cancel("Настройка отменена");
        throw new SetupCancelledError();
      }

      repoUrl = newUrl;
    }
  }

  const deviceName = await clack.text({
    message: "Имя устройства (будет видно в коммитах)",
    placeholder: hostname(),
    initialValue: hostname(),
  });

  if (clack.isCancel(deviceName)) {
    clack.cancel("Настройка отменена");
    throw new SetupCancelledError();
  }

  const localPath = DEFAULT_LOCAL_PATH;

  let branch = "main";

  const s = clack.spinner();
  s.start("Клонирую репозиторий...");

  try {
    clone(String(repoUrl), localPath, "main");
    s.stop("Репозиторий клонирован");
  } catch {
    s.stop("Не удалось клонировать с веткой main, пробую другие варианты");

    if (isGitRepo(localPath)) {
      try {
        rmSync(localPath, { recursive: true, force: true });
      } catch {}
    }

    const remoteBranches = listRemoteBranches(String(repoUrl));

    if (remoteBranches.length === 0) {
      s.stop("Репозиторий пустой, инициализирую...");
      try {
        cloneAll(String(repoUrl), localPath);
        initEmptyRepo(localPath, "main");
        branch = "main";
      } catch {
        s.stop("Не удалось клонировать репозиторий");
        clack.outro(`Проверьте URL и доступ к репозиторию:\n  ${maskUrl(String(repoUrl))}`);
        throw new SetupFailedError("Не удалось клонировать репозиторий");
      }
    } else if (remoteBranches.length === 1) {
      branch = remoteBranches[0];
      clack.log.info(`Обнаружена ветка: ${branch}`);
      try {
        clone(String(repoUrl), localPath, branch);
      } catch {
        s.stop("Не удалось клонировать репозиторий");
        clack.outro(`Проверьте URL и доступ к репозиторию:\n  ${maskUrl(String(repoUrl))}`);
        throw new SetupFailedError("Не удалось клонировать репозиторий");
      }
    } else {
      s.stop();

      if (remoteBranches.includes("master")) {
        branch = "master";
      } else {
        const selectedBranch = await clack.select({
          message: "Выберите ветку",
          options: remoteBranches.map((b) => ({ value: b, label: b })),
        });

        if (clack.isCancel(selectedBranch)) {
          clack.cancel("Настройка отменена");
          throw new SetupCancelledError();
        }

        branch = String(selectedBranch);
      }

      const s2 = clack.spinner();
      s2.start("Клонирую репозиторий...");
      try {
        clone(String(repoUrl), localPath, branch);
        s2.stop("Репозиторий клонирован");
      } catch {
        s2.stop("Не удалось клонировать репозиторий");
        clack.outro(`Проверьте URL и доступ к репозиторию:\n  ${maskUrl(String(repoUrl))}`);
        throw new SetupFailedError("Не удалось клонировать репозиторий");
      }
    }
  }

  const config = {
    repo: String(repoUrl),
    deviceName: String(deviceName),
    localPath,
    branch,
  };

  saveConfig(config);

  clack.log.success("Конфигурация сохранена");

  const s2 = clack.spinner();
  s2.start("Настраиваю автосинхронизацию...");

  const shellResult = installShellFunction();

  if (shellResult.installed) {
    s2.stop("Автосинхронизация настроена");
    clack.note(
      `Обнаружен shell: ${shellResult.shellName}\nДобавляю opencode() в ${shellResult.rcFile}\n\nПерезапустите shell:\n  source ${shellResult.rcFile}`,
      "Готово",
    );
  } else {
    s2.stop("Shell не поддерживается (поддерживаются: bash, zsh, fish, PowerShell)");
    clack.log.warn("Автосинхронизация не настроена. Используйте opencode-sync push/pull вручную");
  }

  clack.outro("Настройка завершена!");
}
