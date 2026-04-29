import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log, OPENCODE_MAX_BUFFER, OPENCODE_TIMEOUT_MS, validateSessionId } from "./util.js";

export const OPENCODE_MIN_VERSION = "1.14.0";

export interface SessionInfo {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  created: number;
  updated: number;
}

export interface SessionExport {
  info: {
    id: string;
    projectID: string;
    projectId?: string;
    title: string;
    directory: string;
    updated?: number;
    time: {
      created: number;
      updated: number;
    };
    [key: string]: unknown;
  };
  messages: Array<{
    info: { id: string; role: string; [key: string]: unknown };
    parts: Array<{ type: string; [key: string]: unknown }>;
  }>;
}

export function getProjectId(data: SessionExport): string {
  return data.info.projectID || data.info.projectId || "global";
}

function getUpdated(data: SessionExport): number {
  if (data.info.time?.updated) return data.info.time.updated;
  return data.info.updated || 0;
}

export interface PushResult {
  exported: number;
  skipped: number;
  errors: number;
}

export interface PullResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  deleted: number;
}

export function _openCodeExecArgs(
  args: string[],
  platform: string,
  envBin?: string,
): { cmd: string; cmdArgs: string[] } {
  const bin = envBin || "opencode";
  if (platform === "win32" && !envBin) {
    return { cmd: "cmd", cmdArgs: ["/c", bin, ...args] };
  }
  return { cmd: bin, cmdArgs: args };
}

function openCodeExecArgs(args: string[]): { cmd: string; cmdArgs: string[] } {
  return _openCodeExecArgs(args, process.platform, process.env.OPENCODE_BIN);
}

function runOpenCode(args: string[]): string {
  const { cmd, cmdArgs } = openCodeExecArgs(args);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: "utf-8",
      timeout: OPENCODE_TIMEOUT_MS,
      maxBuffer: OPENCODE_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    const msg = stderr || err.message;
    throw new Error(`opencode ${args.join(" ")}: ${msg}`);
  }
}

async function runOpenCodeAsync(args: string[]): Promise<string> {
  const { cmd, cmdArgs } = openCodeExecArgs(args);
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      cmdArgs,
      {
        encoding: "utf-8",
        timeout: OPENCODE_TIMEOUT_MS,
        maxBuffer: OPENCODE_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.trim() || err.message;
          reject(new Error(`opencode ${args.join(" ")}: ${msg}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export function listSessions(): SessionInfo[] {
  try {
    const query =
      "SELECT id, title, project_id, directory, time_created, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC";
    const stdout = runOpenCode(["db", query, "--format", "json"]);
    const rows = JSON.parse(stdout) as Array<{
      id: string;
      title: string;
      project_id: string;
      directory: string;
      time_created: number;
      time_updated: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      projectId: row.project_id,
      directory: row.directory,
      created: row.time_created,
      updated: row.time_updated,
    }));
  } catch (err: any) {
    log(`[session] Не удалось получить список сессий: ${err.message}`);
    return [];
  }
}

export function getSessionMap(): Map<string, SessionInfo> {
  const sessions = listSessions();
  const map = new Map<string, SessionInfo>();
  for (const s of sessions) {
    map.set(s.id, s);
  }
  return map;
}

export function exportSession(sessionId: string): SessionExport | null {
  validateSessionId(sessionId);
  try {
    const stdout = runOpenCode(["export", sessionId]);
    return JSON.parse(stdout) as SessionExport;
  } catch (err: any) {
    if (err.message.includes("JSON")) {
      log(`  ⚠ ${sessionId}: битый JSON от opencode export, пропускаем`);
      return null;
    }
    throw err;
  }
}

export async function exportSessionAsync(sessionId: string): Promise<SessionExport | null> {
  validateSessionId(sessionId);
  try {
    const stdout = await runOpenCodeAsync(["export", sessionId]);
    return JSON.parse(stdout) as SessionExport;
  } catch (err: any) {
    if (err.message.includes("JSON")) {
      log(`  ⚠ ${sessionId}: битый JSON от opencode export, пропускаем`);
      return null;
    }
    throw err;
  }
}

export function saveSessionToFile(data: SessionExport, basePath: string): string {
  const sessionId = data.info.id;
  const filePath = join(basePath, "sessions", "global", `${sessionId}.json`);
  const overrideData: SessionExport = {
    ...data,
    info: { ...data.info, projectID: "global" },
  };

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(overrideData, null, 2)}\n`, "utf-8");

  return filePath;
}

export function readSessionFromFile(filePath: string): SessionExport | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionExport;
  } catch {
    log(`[sync] Не удалось прочитать файл сессии: ${filePath}`);
    return null;
  }
}

export function importSession(filePath: string): boolean {
  try {
    const { cmd, cmdArgs } = openCodeExecArgs(["import", filePath]);
    execFileSync(cmd, cmdArgs, {
      encoding: "utf-8",
      timeout: OPENCODE_TIMEOUT_MS,
      maxBuffer: OPENCODE_MAX_BUFFER,
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() || "";
    log(`[sync] Ошибка импорта ${filePath}: ${stderr || err.message}`);
    return false;
  }
}

export function isLocalNewer(local: SessionInfo, filePath: string): boolean {
  if (!existsSync(filePath)) return true;

  const fileData = readSessionFromFile(filePath);
  if (!fileData) return true;

  return local.updated > getUpdated(fileData);
}

export function isRemoteNewer(fileData: SessionExport, localMap: Map<string, SessionInfo>): boolean {
  const sessionId = fileData.info.id;
  const localSession = localMap.get(sessionId);

  if (!localSession) return true;

  return fileData.info.time.updated > localSession.updated;
}

export function deleteSession(sessionId: string): boolean {
  try {
    runOpenCode(["session", "delete", sessionId]);
    return true;
  } catch (err: any) {
    log(`[session] Не удалось удалить сессию ${sessionId}: ${err.message}`);
    return false;
  }
}

export function checkOpenCodeInstalled(): string {
  const { cmd, cmdArgs } = openCodeExecArgs(["--version"]);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return "";
  }
}

export function getOpenCodeVersion(): string | null {
  const output = checkOpenCodeInstalled();
  if (!output) return null;
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

export function isVersionSupported(version: string): boolean {
  const min = OPENCODE_MIN_VERSION.split(".").map(Number);
  const cur = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((cur[i] ?? 0) > (min[i] ?? 0)) return true;
    if ((cur[i] ?? 0) < (min[i] ?? 0)) return false;
  }
  return true;
}
