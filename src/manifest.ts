import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const MANIFESTS_DIR = "manifests";

export function manifestsDir(localPath: string): string {
  return join(localPath, MANIFESTS_DIR);
}

export function readManifest(localPath: string, deviceName: string): Set<string> {
  const filePath = join(manifestsDir(localPath), `${deviceName}.json`);
  if (!existsSync(filePath)) return new Set();
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return new Set(data.sessionIds ?? []);
  } catch {
    return new Set();
  }
}

export function writeManifest(localPath: string, deviceName: string, sessionIds: Set<string>): void {
  const dir = manifestsDir(localPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${deviceName}.json`);
  writeFileSync(filePath, JSON.stringify({ sessionIds: [...sessionIds] }, null, 2) + "\n", "utf-8");
}

export function getGlobalSessionSet(localPath: string): Set<string> {
  const dir = manifestsDir(localPath);
  const global = new Set<string>();

  if (!existsSync(dir)) return global;

  const files = readdirSync(dir).filter((f) => extname(f) === ".json");
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      for (const id of data.sessionIds ?? []) {
        global.add(id);
      }
    } catch {}
  }

  return global;
}

export function findOrphanFiles(sessionsDir: string, aliveIds: Set<string>): string[] {
  const orphans: string[] = [];

  if (!existsSync(sessionsDir)) return orphans;

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".json") {
        const sessionId = entry.name.replace(/\.json$/, "");
        if (!aliveIds.has(sessionId)) {
          orphans.push(fullPath);
        }
      }
    }
  }

  walk(sessionsDir);
  return orphans;
}
