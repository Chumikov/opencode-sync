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

vi.mock("better-sqlite3", () => ({
  default: vi.fn(function (this: any) {
    this.prepare = vi.fn(() => ({
      all: vi.fn().mockReturnValue([]),
    }));
    this.close = vi.fn();
  }),
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
import Database from "better-sqlite3";

const mockExecFile = vi.mocked(execFileSync);
const mockExecFileAsync = vi.mocked(execFile);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

describe("session.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCODE_DB;
    delete process.env.XDG_DATA_HOME;
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
    it("возвращает массив сессий из БД", () => {
      const sessions = [
        mockSessionInfo({ id: "s1", title: "Session 1" }),
        mockSessionInfo({ id: "s2", title: "Session 2" }),
      ];

      mockExistsSync.mockReturnValue(true);
      const originalDB = Database;
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue(sessions) }));
        this.close = vi.fn();
      } as any);

      const result = listSessions();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("s1");
    });

    it("возвращает пустой массив если БД не найдена", () => {
      mockExistsSync.mockReturnValue(false);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = listSessions();

      expect(result).toEqual([]);

      warnSpy.mockRestore();
    });

    it("открывает БД в readonly режиме", () => {
      mockExistsSync.mockReturnValue(true);
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue([]) }));
        this.close = vi.fn();
      } as any);

      listSessions();

      expect(Database).toHaveBeenCalledWith(expect.any(String), {
        readonly: true,
      });
    });

    it("закрывает БД после чтения", () => {
      mockExistsSync.mockReturnValue(true);
      const closeFn = vi.fn();
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue([]) }));
        this.close = closeFn;
      } as any);

      listSessions();

      expect(closeFn).toHaveBeenCalled();
    });

    it("закрывает БД даже при ошибке запроса", () => {
      mockExistsSync.mockReturnValue(true);
      const closeFn = vi.fn();
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({
          all: vi.fn().mockImplementation(() => {
            throw new Error("SQL error");
          }),
        }));
        this.close = closeFn;
      } as any);

      expect(() => listSessions()).toThrow();
      expect(closeFn).toHaveBeenCalled();
    });
  });

  describe("getSessionMap", () => {
    it("возвращает Map с правильными ключами", () => {
      const sessions = [
        mockSessionInfo({ id: "s1" }),
        mockSessionInfo({ id: "s2" }),
      ];

      mockExistsSync.mockReturnValue(true);
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue(sessions) }));
        this.close = vi.fn();
      } as any);

      const map = getSessionMap();

      expect(map.size).toBe(2);
      expect(map.get("s1")).toBeDefined();
      expect(map.get("s2")).toBeDefined();
    });

    it("возвращает пустой Map если сессий нет", () => {
      mockExistsSync.mockReturnValue(false);

      const map = getSessionMap();

      expect(map.size).toBe(0);
    });
  });

  describe("exportSession", () => {
    it("экспортирует сессию через opencode CLI", () => {
      const exported = mockSessionExport();
      mockExecFile.mockReturnValue(JSON.stringify(exported));

      const result = exportSession("s1");

      expect(result).not.toBeNull();
      expect(result!.info.id).toBe("01JTEST00000000000000000001");
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        ["export", "s1"],
        expect.any(Object),
      );
    });

    it("возвращает null при битом JSON", () => {
      mockExecFile.mockReturnValue("NOT JSON {{{");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = exportSession("s1");

      expect(result).toBeNull();

      warnSpy.mockRestore();
    });

    it("пробрасывает не-JSON ошибки", () => {
      mockExecFile.mockImplementation(() => {
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
      mockExecFileAsync.mockImplementation(((_bin: any, _args: any, _opts: any, cb: any) => {
        cb(null, JSON.stringify(exported), "");
      }) as any);

      const result = await exportSessionAsync("s1");

      expect(result).not.toBeNull();
      expect(result!.info.id).toBe("01JTEST00000000000000000001");
    });

    it("возвращает null при битом JSON", async () => {
      mockExecFileAsync.mockImplementation(((_bin: any, _args: any, _opts: any, cb: any) => {
        cb(null, "NOT JSON {{{", "");
      }) as any);

      const result = await exportSessionAsync("s1");

      expect(result).toBeNull();
    });

    it("пробрасывает не-JSON ошибки", async () => {
      mockExecFileAsync.mockImplementation(((_bin: any, _args: any, _opts: any, cb: any) => {
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
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = readSessionFromFile("/tmp/bad.json");

      expect(result).toBeNull();

      warnSpy.mockRestore();
    });
  });

  describe("importSession", () => {
    it("возвращает true при успешном импорте", () => {
      mockExecFile.mockReturnValue("");

      const result = importSession("/tmp/sync/sessions/abc/s1.json");

      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        expect.any(String),
        ["import", "/tmp/sync/sessions/abc/s1.json"],
        expect.any(Object),
      );
    });

    it("возвращает false при ошибке", () => {
      mockExecFile.mockImplementation(() => {
        throw Object.assign(new Error("import failed"), { stderr: "error" });
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = importSession("/tmp/bad.json");

      expect(result).toBe(false);

      errorSpy.mockRestore();
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
      vi.spyOn(console, "warn").mockImplementation(() => {});

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

  describe("getOpenCodeDbPath", () => {
    it("использует OPENCODE_DB env переменную", () => {
      mockExistsSync.mockReturnValue(true);
      process.env.OPENCODE_DB = "/custom/path/opencode.db";
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue([]) }));
        this.close = vi.fn();
      } as any);

      listSessions();

      expect(Database).toHaveBeenCalledWith(
        "/custom/path/opencode.db",
        expect.any(Object),
      );
    });

    it("передаёт OPENCODE_DB напрямую в Database", () => {
      mockExistsSync.mockReturnValue(true);
      process.env.OPENCODE_DB = "/custom/path/opencode.db";
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue([]) }));
        this.close = vi.fn();
      } as any);

      listSessions();

      expect(Database).toHaveBeenCalledWith(
        "/custom/path/opencode.db",
        expect.any(Object),
      );
    });

    it("OPENCODE_DB=:memory: передаётся как есть", () => {
      mockExistsSync.mockReturnValue(true);
      process.env.OPENCODE_DB = ":memory:";
      vi.mocked(Database).mockImplementationOnce(function (this: any) {
        this.prepare = vi.fn(() => ({ all: vi.fn().mockReturnValue([]) }));
        this.close = vi.fn();
      } as any);

      listSessions();

      expect(Database).toHaveBeenCalledWith(
        ":memory:",
        expect.any(Object),
      );
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
