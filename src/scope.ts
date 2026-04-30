import { execFileSync } from "node:child_process";
import { log } from "./util.js";

export type ProjectScope = { type: "project"; projectId: string } | { type: "global" };

export function _getGitRoot(cwd: string): string | null {
  try {
    const result = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 5000,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function _getFirstCommit(gitRoot: string): string | null {
  try {
    const result = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
      cwd: gitRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export function detectProjectScope(cwd?: string): ProjectScope {
  const dir = cwd || process.cwd();

  const gitRoot = _getGitRoot(dir);
  if (!gitRoot) {
    log("[scope] Git-репозиторий не найден, режим: global");
    return { type: "global" };
  }

  const firstCommit = _getFirstCommit(gitRoot);
  if (!firstCommit) {
    log("[scope] Пустой git-репозиторий (нет коммитов), режим: global");
    return { type: "global" };
  }

  log(`[scope] Проект: ${firstCommit} (${gitRoot})`);
  return { type: "project", projectId: firstCommit };
}

export function scopeProjectId(scope: ProjectScope): string {
  return scope.type === "project" ? scope.projectId : "global";
}
