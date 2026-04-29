import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncConfig } from "./config.js";
import { checkInternet } from "./net.js";
import { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, log, withRetry } from "./util.js";

const GIT_BIN = process.env.GIT_BIN || "git";

const SYNC_GITIGNORE = `.DS_Store
Thumbs.db
*.tmp
*.bak
*~
`;

function runGit(args: string[], cwd?: string): string {
  try {
    const result = execFileSync(GIT_BIN, args, {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    const msg = stderr || err.message;

    const safeArgs = args.map((a) => (a.includes("@") || a.startsWith("http") ? maskUrl(a) : a));
    throw new Error(`git ${safeArgs.join(" ")}: ${msg}`);
  }
}

function ensureGitignore(localPath: string): void {
  const giPath = join(localPath, ".gitignore");
  if (!existsSync(giPath)) {
    writeFileSync(giPath, SYNC_GITIGNORE, "utf-8");
  }
}

export function isGitRepo(dirPath: string): boolean {
  return existsSync(join(dirPath, ".git"));
}

export function clone(repoUrl: string, localPath: string, branch: string): void {
  log(`[git] Клонирование ${maskUrl(repoUrl)} → ${localPath}`);

  runGit(["clone", "--branch", branch, "--single-branch", repoUrl, localPath]);
  ensureGitignore(localPath);

  log("[git] Репозиторий клонирован");
}

export function cloneAll(repoUrl: string, localPath: string): void {
  log(`[git] Клонирование (все ветки) ${maskUrl(repoUrl)} → ${localPath}`);

  runGit(["clone", repoUrl, localPath]);
  ensureGitignore(localPath);

  log("[git] Репозиторий клонирован");
}

export function initEmptyRepo(localPath: string, branch: string): void {
  log(`[git] Инициализация пустого репозитория: branch=${branch}`);

  runGit(["checkout", "-b", branch], localPath);
  runGit(["commit", "--allow-empty", "-m", "init: initial commit"], localPath);
  runGit(["push", "-u", "origin", branch], localPath);

  log("[git] Пустой репозиторий инициализирован");
}

export function listRemoteBranches(repoUrl: string): string[] {
  try {
    const result = runGit(["ls-remote", "--heads", repoUrl]);
    return result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[a-f0-9]+\trefs\/heads\//, ""))
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

export function hasCommits(localPath: string): boolean {
  try {
    runGit(["rev-parse", "HEAD"], localPath);
    return true;
  } catch {
    return false;
  }
}

export function ensureRepo(repoUrl: string, localPath: string, branch: string): void {
  if (isGitRepo(localPath)) {
    try {
      const remoteUrl = runGit(["config", "--get", "remote.origin.url"], localPath).trim();
      if (remoteUrl !== repoUrl) {
        log(`[git] Обновление remote URL`);
        runGit(["remote", "set-url", "origin", repoUrl], localPath);
      }
    } catch {
      runGit(["remote", "add", "origin", repoUrl], localPath);
    }
    ensureGitignore(localPath);

    if (!hasCommits(localPath)) {
      log("[git] Пустой клон, инициализирую...");
      initEmptyRepo(localPath, branch);
    }
  } else {
    clone(repoUrl, localPath, branch);
  }
}

export function pull(localPath: string, branch: string): boolean {
  try {
    const result = runGit(["pull", "--rebase", "--strategy-option", "theirs", "origin", branch], localPath);

    const hasChanges = !result.includes("Already up to date");
    if (hasChanges) {
      log("[git] Подтягивание завершено, есть новые изменения");
    } else {
      log("[git] Изменений нет, уже актуально");
    }
    return hasChanges;
  } catch (err: any) {
    if (err.message.includes("CONFLICT") || err.message.includes("conflict")) {
      log("[git] Merge-конфликт при pull, прерываем rebase");
      try {
        runGit(["rebase", "--abort"], localPath);
      } catch {}
      throw new Error("Merge-конфликт. Попробуйте opencode-sync push --force");
    }
    throw err;
  }
}

export function commit(localPath: string, deviceName: string): boolean {
  runGit(["add", "--all"], localPath);

  try {
    runGit(["diff", "--cached", "--quiet"], localPath);
    return false;
  } catch {}

  const timestamp = new Date().toISOString();
  const message = `sync: ${deviceName} @ ${timestamp}`;
  runGit(["commit", "-m", message], localPath);

  log(`[git] Коммит: ${message}`);
  return true;
}

export async function push(localPath: string, branch: string, deviceName: string): Promise<void> {
  try {
    await withRetry(() => pull(localPath, branch));
  } catch (err: any) {
    log(`[git] Предупреждение при pull: ${err.message}`);
  }

  const hasCommit = commit(localPath, deviceName);

  if (hasCommit) {
    log(`[git] Push в origin/${branch}...`);
    await withRetry(() => runGit(["push", "-u", "origin", branch], localPath));
    log("[git] Push завершён");
  } else {
    log("[git] Нет изменений для push");
  }
}

export function listBranches(localPath: string): string[] {
  try {
    const result = runGit(["branch", "-r"], localPath);
    return result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("origin/"))
      .map((line) => line.replace(/^origin\//, ""))
      .filter((line) => line.length > 0 && !line.includes("HEAD"));
  } catch {
    return [];
  }
}

export function getDefaultBranch(localPath: string): string | null {
  try {
    const result = runGit(["symbolic-ref", "--short", "HEAD"], localPath);
    return result.trim() || null;
  } catch {
    return null;
  }
}

export interface RepoAccessResult {
  ok: true;
}

export interface RepoAccessError {
  ok: false;
  error: string;
  hint: string;
}

export type CheckRepoAccessResult = RepoAccessResult | RepoAccessError;

function parseAccessError(stderr: string): { error: string; hint: string } {
  const lower = stderr.toLowerCase();

  if (lower.includes("permission denied") || lower.includes("publickey")) {
    return {
      error: "Нет SSH-доступа к репозиторию",
      hint: `Проверьте что SSH-ключ добавлен в аккаунт:\n  ssh -T git@github.com\n\nЕсли ключ не добавлен, сгенерируйте и добавьте:\n  ssh-keygen -t ed25519\n  cat ~/.ssh/id_ed25519.pub  → скопируйте в GitHub Settings → SSH keys`,
    };
  }

  if (lower.includes("not found") || lower.includes("does not exist") || lower.includes("couldn't find")) {
    return {
      error: "Репозиторий не найден",
      hint: `Возможные причины:\n  1. Опечатка в URL — проверьте название репозитория\n  2. Репозиторий не существует — создайте его на GitHub\n  3. Нет прав на чтение — запросите доступ у владельца`,
    };
  }

  if (
    lower.includes("could not read username") ||
    lower.includes("authentication failed") ||
    lower.includes("fatal: could not read") ||
    lower.includes("access denied")
  ) {
    return {
      error: "Ошибка аутентификации",
      hint: `Для HTTPS-URL используйте personal access token:\n  https://<token>@github.com/user/repo.git\n\nТокен можно создать: GitHub → Settings → Developer settings → Personal access tokens\n\nИли переключитесь на SSH:\n  git@github.com:user/repo.git`,
    };
  }

  if (
    lower.includes("timed out") ||
    lower.includes("could not resolve") ||
    lower.includes("connection refused") ||
    lower.includes("network is unreachable")
  ) {
    return {
      error: "Не удалось подключиться к серверу",
      hint: `Проверьте:\n  1. Интернет-соединение: ping github.com\n  2. Доступность хоста (возможно, блокируется firewall/VPN)\n  3. Правильность URL`,
    };
  }

  return {
    error: maskUrl(stderr),
    hint: `Проверьте:\n  1. Правильность URL репозитория\n  2. Наличие SSH-ключа или HTTPS-токена\n  3. Права доступа к репозиторию`,
  };
}

export function checkRepoAccess(repoUrl: string): CheckRepoAccessResult {
  try {
    execFileSync(GIT_BIN, ["ls-remote", repoUrl, "HEAD"], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || err.message || "";
    const parsed = parseAccessError(stderr);
    return { ok: false, error: parsed.error, hint: parsed.hint };
  }
}

export function maskUrl(url: string): string {
  try {
    if (url.startsWith("git@")) {
      const parts = url.split(":");
      return `${parts[0]}:***`;
    }

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

export class PreflightError extends Error {
  hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "PreflightError";
    this.hint = hint;
  }
}

export async function preflightCheck(config: SyncConfig): Promise<void> {
  const hasInternet = await checkInternet();
  if (!hasInternet) {
    throw new PreflightError(
      "Нет подключения к интернету",
      `Проверьте:\n  1. WiFi/кабель подключён\n  2. DNS работает: nslookup google.com\n  3. Нет блокировки на уровне провайдера`,
    );
  }

  const access = checkRepoAccess(config.repo);
  if (!access.ok) {
    throw new PreflightError(access.error, access.hint);
  }
}
