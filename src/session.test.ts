import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listSessions,
  getSessionMap,
  exportSession,
  exportSessionAsync,
  saveSessionToFile,
  readSessionFromFile,
  importSession,
  isLocalNewer,
  isRemoteNewer,
  getProjectId,
  deleteSession,
  checkOpenCodeInstalled,
} from "./session.js";
import { mockSessionInfo, mockSessionExport } from "./__tests__/helpers.js";

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

import { execFileSync, execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function mockSessionListJSON(sessions: ReturnType<typeof mockSessionInfo>[]) {
  mockExecFileSync.mockReturnValue(JSON.stringify(sessions));
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
    it("вызывает opencode session list --format json", () => {
      const sessions = [
        mockSessionInfo({ id: "s1", title: "Session 1" }),
        mockSessionInfo({ id: "s2", title: "Session 2" }),
      ];
      mockSessionListJSON(sessions);

      const result = listSessions();

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "opencode",
        ["session", "list", "--format", "json"],
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
      const sessions = [
        mockSessionInfo({ id: "s1" }),
        mockSessionInfo({ id: "s2" }),
      ];
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
      expect(result!.info.id).toBe("01JTEST00000000000000000001");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.any(String),
        ["export", "s1"],
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
      expect(result!.info.id).toBe("01JTEST00000000000000000001");
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
    it("сохраняет в sessions/{projectId}/{sessionId}.json", () => {
      const data = mockSessionExport();

      const path = saveSessionToFile(data, "/tmp/sync");

      expect(path).toBe(
        "/tmp/sync/sessions/abc123/01JTEST00000000000000000001.json",
      );
      expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        path,
        expect.any(String),
        "utf-8",
      );
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
      expect(result!.info.id).toBe("01JTEST00000000000000000001");
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
        expect.any(String),
        ["import", "/tmp/sync/sessions/abc/s1.json"],
        expect.any(Object),
      );
    });

    it("возвращает false при ошибке", () => {
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error("import failed"), { stderr: "error" });
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
        expect.any(String),
        ["session", "delete", "s1"],
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
    it("возвращает путь к бинарнику если opencode установлен", () => {
      mockExecFileSync.mockReturnValue("1.14.25\n");

      const result = checkOpenCodeInstalled();

      expect(result).toBe("opencode");
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

      expect(result).toBe("/custom/opencode");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "/custom/opencode",
        ["--version"],
        expect.any(Object),
      );
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
      const localMap = new Map([
        ["01JTEST00000000000000000001", mockSessionInfo({ updated: 1700000000000 })],
      ]);
      const fileData = mockSessionExport({
        info: {
          ...mockSessionExport().info,
          time: { created: 1700000000000, updated: 1700000200000 },
        },
      });

      expect(isRemoteNewer(fileData, localMap)).toBe(true);
    });

    it("возвращает false если локальная новее", () => {
      const localMap = new Map([
        ["01JTEST00000000000000000001", mockSessionInfo({ updated: 1700000200000 })],
      ]);
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
      const localMap = new Map([
        ["01JTEST00000000000000000001", mockSessionInfo({ updated: ts })],
      ]);
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
});
