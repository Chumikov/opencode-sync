import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_TIMEOUT_MS, GIT_MAX_BUFFER, log, withRetry } from "./util.js";

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
  } else {
    clone(repoUrl, localPath, branch);
  }
}

export function pull(localPath: string, branch: string): boolean {
  try {
    const result = runGit(
      ["pull", "--rebase", "--strategy-option", "theirs", "origin", branch],
      localPath,
    );

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
    await withRetry(() => runGit(["push", "origin", branch], localPath));
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
