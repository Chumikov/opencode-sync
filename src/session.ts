import { execFileSync, execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  OPENCODE_TIMEOUT_MS,
  OPENCODE_MAX_BUFFER,
  validateSessionId,
  log,
} from "./util.js";

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

const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

function runOpenCode(args: string[]): string {
  try {
    const result = execFileSync(OPENCODE_BIN, args, {
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
  return new Promise((resolve, reject) => {
    execFile(OPENCODE_BIN, args, {
      encoding: "utf-8",
      timeout: OPENCODE_TIMEOUT_MS,
      maxBuffer: OPENCODE_MAX_BUFFER,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`opencode ${args.join(" ")}: ${msg}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export function listSessions(): SessionInfo[] {
  try {
    const stdout = runOpenCode(["session", "list", "--format", "json"]);
    const sessions = JSON.parse(stdout) as SessionInfo[];
    return sessions;
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
  const projectId = getProjectId(data);
  const sessionId = data.info.id;
  const filePath = join(basePath, "sessions", projectId, `${sessionId}.json`);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");

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
    runOpenCode(["import", filePath]);
    return true;
  } catch (err: any) {
    log(`[sync] Ошибка импорта ${filePath}: ${err.message}`);
    return false;
  }
}

export function isLocalNewer(local: SessionInfo, filePath: string): boolean {
  if (!existsSync(filePath)) return true;

  const fileData = readSessionFromFile(filePath);
  if (!fileData) return true;

  return local.updated > getUpdated(fileData);
}

export function isRemoteNewer(
  fileData: SessionExport,
  localMap: Map<string, SessionInfo>,
): boolean {
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
  const bin = process.env.OPENCODE_BIN || "opencode";
  try {
    execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return bin;
  } catch {
    return "";
  }
}
