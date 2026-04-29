import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockSessionExport, mockSessionInfo } from "./__tests__/helpers.js";
import {
  _openCodeExecArgs,
  checkOpenCodeInstalled,
  deleteSession,
  exportSession,
  exportSessionAsync,
  getOpenCodeVersion,
  getProjectId,
  getSessionMap,
  importSession,
  isLocalNewer,
  isRemoteNewer,
  isVersionSupported,
  listSessions,
  readSessionFromFile,
  saveSessionToFile,
} from "./session.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("./util.js", () => ({
  OPENCODE_TIMEOUT_MS: 30_000,
  OPENCODE_MAX_BUFFER: 50 * 1024 * 1024,
  validateSessionId: vi.fn(),
  log: vi.fn(),
  EXPORT_CONCURRENCY: 5,
}));

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function mockSessionListJSON(
  sessions: Array<{
    id: string;
    title: string;
    projectId?: string;
    directory?: string;
    created?: number;
    updated?: number;
  }>,
) {
  const rows = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    project_id: s.projectId || "global",
    directory: s.directory || "/tmp",
    time_created: s.created || Date.now(),
    time_updated: s.updated || Date.now(),
  }));
  mockExecFileSync.mockReturnValue(JSON.stringify(rows));
}

describe("session.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCODE_DB;
    delete process.env.OPENCODE_BIN;
  });

  describe("getProjectId", () => {
    it("извлекает projectID (с большой D)", () => {
      const data = mockSessionExport();
      expect(getProjectId(data)).toBe("abc123");
    });

    it("fallback на projectId (с маленькой d)", () => {
      const data = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          projectID: undefined as any,
          projectId: "xyz789" as any,
        },
      });
      expect(getProjectId(data)).toBe("xyz789");
    });

    it("fallback на 'global' если оба отсутствуют", () => {
      const data = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          projectID: undefined as any,
        },
      });
      delete (data.info as any).projectId;
      expect(getProjectId(data)).toBe("global");
    });
  });

  describe("listSessions", () => {
    it("вызывает opencode db для получения всех сессий", () => {
      const sessions = [
        { id: "s1", title: "Session 1" },
        { id: "s2", title: "Session 2" },
      ];
      mockSessionListJSON(sessions);

      const result = listSessions();

      expect(mockExecFileSync).toHaveBeenCalledWith(
        process.platform === "win32" ? "cmd" : "opencode",
        process.platform === "win32"
          ? ["/c", "opencode", "db", expect.stringContaining("SELECT"), "--format", "json"]
          : ["db", expect.stringContaining("SELECT"), "--format", "json"],
        expect.any(Object),
      );
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("s1");
    });

    it("возвращает пустой массив при ошибке команды", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("command not found");
      });

      const result = listSessions();

      expect(result).toEqual([]);
    });

    it("возвращает пустой массив при битом JSON", () => {
      mockExecFileSync.mockReturnValue("NOT JSON {{{");

      const result = listSessions();

      expect(result).toEqual([]);
    });
  });

  describe("getSessionMap", () => {
    it("возвращает Map с правильными ключами", () => {
      const sessions = [mockSessionInfo({ id: "s1" }), mockSessionInfo({ id: "s2" })];
      mockSessionListJSON(sessions);

      const map = getSessionMap();

      expect(map.size).toBe(2);
      expect(map.get("s1")).toBeDefined();
      expect(map.get("s2")).toBeDefined();
    });

    it("возвращает пустой Map если сессий нет", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("no opencode");
      });

      const map = getSessionMap();

      expect(map.size).toBe(0);
    });
  });

  describe("exportSession", () => {
    it("экспортирует сессию через opencode CLI", () => {
      const exported = mockSessionExport();
      mockExecFileSync.mockReturnValue(JSON.stringify(exported));

      const result = exportSession("s1");

      expect(result).not.toBeNull();
      expect(result?.info.id).toBe("01JTEST00000000000000000001");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        process.platform === "win32" ? "cmd" : expect.any(String),
        process.platform === "win32" ? ["/c", "opencode", "export", "s1"] : ["export", "s1"],
        expect.any(Object),
      );
    });

    it("возвращает null при битом JSON", () => {
      mockExecFileSync.mockReturnValue("NOT JSON {{{");

      const result = exportSession("s1");

      expect(result).toBeNull();
    });

    it("пробрасывает не-JSON ошибки", () => {
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("opencode export: command failed"), {
          stderr: "command not found",
        });
      });

      expect(() => exportSession("s1")).toThrow("command not found");
    });
  });

  describe("exportSessionAsync", () => {
    it("экспортирует сессию через async execFile", async () => {
      const exported = mockSessionExport();
      mockExecFile.mockImplementation(((_bin: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(exported), "");
      }) as any);

      const result = await exportSessionAsync("s1");

      expect(result).not.toBeNull();
      expect(result?.info.id).toBe("01JTEST00000000000000000001");
    });

    it("возвращает null при битом JSON", async () => {
      mockExecFile.mockImplementation(((_bin: any, _args: any, _opts: any, cb: any) => {
        cb(null, "NOT JSON {{{", "");
      }) as any);

      const result = await exportSessionAsync("s1");

      expect(result).toBeNull();
    });

    it("пробрасывает не-JSON ошибки", async () => {
      mockExecFile.mockImplementation(((_bin: any, _args: any, _opts: any, cb: any) => {
        cb(new Error("export failed"), "", "stderr");
      }) as any);

      await expect(exportSessionAsync("s1")).rejects.toThrow("opencode export s1");
    });
  });

  describe("saveSessionToFile", () => {
    it("сохраняет в sessions/global/{sessionId}.json с project_id = global", () => {
      const data = mockSessionExport();

      const path = saveSessionToFile(data, "/tmp/sync");

      expect(path).toBe(join("/tmp/sync", "sessions", "global", "01JTEST00000000000000000001.json"));
      expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      });
      expect(mockWriteFileSync).toHaveBeenCalledWith(path, expect.any(String), "utf-8");
      const written = vi.mocked(mockWriteFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.info.projectID).toBe("global");
    });

    it("сохраняет форматированный JSON", () => {
      const data = mockSessionExport();

      saveSessionToFile(data, "/tmp/sync");

      const written = mockWriteFileSync.mock.calls[0][1] as string;
      expect(written.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(written);
      expect(parsed.info.id).toBe("01JTEST00000000000000000001");
    });
  });

  describe("readSessionFromFile", () => {
    it("читает валидный JSON-файл", () => {
      const exported = mockSessionExport();
      mockReadFileSync.mockReturnValue(JSON.stringify(exported));

      const result = readSessionFromFile("/tmp/sync/sessions/abc/s1.json");

      expect(result).not.toBeNull();
      expect(result?.info.id).toBe("01JTEST00000000000000000001");
    });

    it("возвращает null для повреждённого файла", () => {
      mockReadFileSync.mockReturnValue("BROKEN JSON");

      const result = readSessionFromFile("/tmp/bad.json");

      expect(result).toBeNull();
    });
  });

  describe("importSession", () => {
    it("возвращает true при успешном импорте", () => {
      mockExecFileSync.mockReturnValue("");

      const result = importSession("/tmp/sync/sessions/abc/s1.json");

      expect(result).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        process.platform === "win32" ? "cmd" : expect.any(String),
        process.platform === "win32"
          ? ["/c", "opencode", "import", "/tmp/sync/sessions/abc/s1.json"]
          : ["import", "/tmp/sync/sessions/abc/s1.json"],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
    });

    it("возвращает false при ошибке без stderr", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("import failed");
      });

      const result = importSession("/tmp/bad.json");

      expect(result).toBe(false);
    });
  });

  describe("deleteSession", () => {
    it("вызывает opencode session delete", () => {
      mockExecFileSync.mockReturnValue("");

      const result = deleteSession("s1");

      expect(result).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        process.platform === "win32" ? "cmd" : expect.any(String),
        process.platform === "win32" ? ["/c", "opencode", "session", "delete", "s1"] : ["session", "delete", "s1"],
        expect.any(Object),
      );
    });

    it("возвращает false при ошибке", () => {
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("delete failed"), { stderr: "error" });
      });

      const result = deleteSession("s1");

      expect(result).toBe(false);
    });
  });

  describe("checkOpenCodeInstalled", () => {
    it("возвращает версию если opencode установлен", () => {
      mockExecFileSync.mockReturnValue("1.14.25\n");

      const result = checkOpenCodeInstalled();

      expect(result).toBe("1.14.25");
    });

    it("возвращает пустую строку если opencode не установлен", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const result = checkOpenCodeInstalled();

      expect(result).toBe("");
    });

    it("использует OPENCODE_BIN из env", () => {
      process.env.OPENCODE_BIN = "/custom/opencode";
      mockExecFileSync.mockReturnValue("1.0.0\n");

      const result = checkOpenCodeInstalled();

      expect(result).toBe("1.0.0");
      expect(mockExecFileSync).toHaveBeenCalledWith("/custom/opencode", ["--version"], expect.any(Object));
    });
  });

  describe("getOpenCodeVersion", () => {
    it("извлекает версию из вывода", () => {
      mockExecFileSync.mockReturnValue("opencode/1.14.25\n");

      const result = getOpenCodeVersion();

      expect(result).toBe("1.14.25");
    });

    it("возвращает null если opencode не установлен", () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      expect(getOpenCodeVersion()).toBeNull();
    });

    it("возвращает null если вывод не содержит версию", () => {
      mockExecFileSync.mockReturnValue("no version here\n");

      expect(getOpenCodeVersion()).toBeNull();
    });
  });

  describe("isVersionSupported", () => {
    it("поддерживает версию >= минимума", () => {
      expect(isVersionSupported("1.14.0")).toBe(true);
      expect(isVersionSupported("1.14.1")).toBe(true);
      expect(isVersionSupported("2.0.0")).toBe(true);
    });

    it("отклоняет версию < минимума", () => {
      expect(isVersionSupported("1.13.99")).toBe(false);
      expect(isVersionSupported("0.99.0")).toBe(false);
    });
  });

  describe("isLocalNewer", () => {
    it("возвращает true если файла не существует", () => {
      mockExistsSync.mockReturnValue(false);

      const result = isLocalNewer(mockSessionInfo(), "/tmp/no-file.json");

      expect(result).toBe(true);
    });

    it("возвращает true если локальная сессия новее", () => {
      mockExistsSync.mockReturnValue(true);
      const fileData = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          time: { created: 1700000000000, updated: 1700000000000 },
        },
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(fileData));

      const local = mockSessionInfo({ updated: 1700000200000 });
      const result = isLocalNewer(local, "/tmp/sync/sessions/abc/s1.json");

      expect(result).toBe(true);
    });

    it("возвращает false если файл новее", () => {
      mockExistsSync.mockReturnValue(true);
      const fileData = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          time: { created: 1700000000000, updated: 1700000200000 },
        },
      });
      mockReadFileSync.mockReturnValue(JSON.stringify(fileData));

      const local = mockSessionInfo({ updated: 1700000100000 });
      const result = isLocalNewer(local, "/tmp/sync/sessions/abc/s1.json");

      expect(result).toBe(false);
    });

    it("возвращает true если файл повреждён", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("BAD JSON");

      const result = isLocalNewer(mockSessionInfo(), "/tmp/broken.json");

      expect(result).toBe(true);
    });
  });

  describe("isRemoteNewer", () => {
    it("возвращает true если сессии нет локально", () => {
      const localMap = new Map();
      const fileData = mockSessionExport();

      expect(isRemoteNewer(fileData, localMap)).toBe(true);
    });

    it("возвращает true если remote новее", () => {
      const localMap = new Map([["01JTEST00000000000000000001", mockSessionInfo({ updated: 1700000000000 })]]);
      const fileData = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          time: { created: 1700000000000, updated: 1700000200000 },
        },
      });

      expect(isRemoteNewer(fileData, localMap)).toBe(true);
    });

    it("возвращает false если локальная новее", () => {
      const localMap = new Map([["01JTEST00000000000000000001", mockSessionInfo({ updated: 1700000200000 })]]);
      const fileData = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          time: { created: 1700000000000, updated: 1700000100000 },
        },
      });

      expect(isRemoteNewer(fileData, localMap)).toBe(false);
    });

    it("возвращает false если timestamp одинаковый", () => {
      const ts = 1700000100000;
      const localMap = new Map([["01JTEST00000000000000000001", mockSessionInfo({ updated: ts })]]);
      const fileData = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          time: { created: ts, updated: ts },
        },
      });

      expect(isRemoteNewer(fileData, localMap)).toBe(false);
    });
  });

  describe("getUpdated fallback", () => {
    it("использует info.updated когда info.time.updated отсутствует", () => {
      mockExistsSync.mockReturnValue(true);
      const fileData = {
        info: {
          id: "s1",
          projectID: "p1",
          title: "T",
          directory: "/tmp",
          time: {},
          updated: 1700000100000,
        },
        messages: [],
      };

      const local = mockSessionInfo({ id: "s1", updated: 1700000300000 });
      mockReadFileSync.mockReturnValue(JSON.stringify(fileData));

      expect(isLocalNewer(local, "/tmp/sync/sessions/p1/s1.json")).toBe(true);
    });
  });

  describe("_openCodeExecArgs", () => {
    it("возвращает cmd /c на Windows без OPENCODE_BIN", () => {
      const result = _openCodeExecArgs(["list"], "win32");
      expect(result).toEqual({ cmd: "cmd", cmdArgs: ["/c", "opencode", "list"] });
    });

    it("вызывает бинаррь напрямую на Windows с OPENCODE_BIN", () => {
      const result = _openCodeExecArgs(["list"], "win32", "/usr/local/bin/opencode");
      expect(result).toEqual({ cmd: "/usr/local/bin/opencode", cmdArgs: ["list"] });
    });

    it("вызывает бинаррь напрямую на Linux без OPENCODE_BIN", () => {
      const result = _openCodeExecArgs(["list"], "linux");
      expect(result).toEqual({ cmd: "opencode", cmdArgs: ["list"] });
    });

    it("вызывает бинаррь напрямую на macOS с OPENCODE_BIN", () => {
      const result = _openCodeExecArgs(["list"], "darwin", "/opt/bin/opencode");
      expect(result).toEqual({ cmd: "/opt/bin/opencode", cmdArgs: ["list"] });
    });
  });
});
