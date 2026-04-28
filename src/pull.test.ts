import { describe, it, expect, vi, beforeEach } from "vitest";
import { pullSessions } from "./pull.js";
import { mockSessionInfo, mockSessionExport, mockConfig } from "./__tests__/helpers.js";

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(),
  sessionsDir: vi.fn(),
}));

vi.mock("./session.js", () => ({
  getSessionMap: vi.fn(),
  readSessionFromFile: vi.fn(),
  importSession: vi.fn(),
  isRemoteNewer: vi.fn(),
  deleteSession: vi.fn(),
  checkOpenCodeInstalled: vi.fn(() => true),
}));

vi.mock("./git.js", () => ({
  pull: vi.fn(),
  ensureRepo: vi.fn(),
  preflightCheck: vi.fn(async () => {}),
  PreflightError: class PreflightError extends Error {
    hint: string;
    constructor(m: string, h: string) { super(m); this.hint = h; }
  },
}));

vi.mock("./util.js", () => ({
  log: vi.fn(),
  withLock: vi.fn((_, fn) => fn()),
}));

vi.mock("./manifest.js", () => ({
  getGlobalSessionSet: vi.fn(() => new Set()),
}));



import { readdirSync, statSync } from "node:fs";
import { loadConfig, sessionsDir } from "./config.js";
import { getSessionMap, readSessionFromFile, importSession, isRemoteNewer, deleteSession, checkOpenCodeInstalled } from "./session.js";
import { pull as gitPull, ensureRepo, preflightCheck } from "./git.js";
import { log, withLock } from "./util.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockSessionsDir = vi.mocked(sessionsDir);
const mockGetSessionMap = vi.mocked(getSessionMap);
const mockReadSession = vi.mocked(readSessionFromFile);
const mockImportSession = vi.mocked(importSession);
const mockIsRemoteNewer = vi.mocked(isRemoteNewer);
const mockGitPull = vi.mocked(gitPull);
const mockEnsureRepo = vi.mocked(ensureRepo);
const mockPreflightCheck = vi.mocked(preflightCheck);
const mockReaddirSync = vi.mocked(readdirSync);
const mockStatSync = vi.mocked(statSync);
const mockLog = vi.mocked(log);
const mockWithLock = vi.mocked(withLock);

function mockFsStructure(structure: Record<string, string[]>) {
  mockStatSync.mockImplementation((dir: any) => {
    const dirStr = String(dir);
    for (const [key] of Object.entries(structure)) {
      if (dirStr === key || dirStr.endsWith(key)) {
        return { isDirectory: () => true } as any;
      }
    }
    return undefined as any;
  });

  mockReaddirSync.mockImplementation((dir: any) => {
    const dirStr = String(dir);
    for (const [key, entries] of Object.entries(structure)) {
      if (dirStr === key || dirStr.endsWith(key)) {
        return entries.map((name) => ({
          name,
          isDirectory: () => !name.endsWith(".json"),
          isFile: () => name.endsWith(".json"),
        }));
      }
    }
    return [] as any;
  });
}

describe("pull.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(mockConfig());
    mockSessionsDir.mockReturnValue("/tmp/sync/sessions");
    mockGetSessionMap.mockReturnValue(new Map());
    mockGitPull.mockReturnValue(true);
    mockEnsureRepo.mockReturnValue(undefined);
  });

  it("импортирует новые сессии", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    const result = await pullSessions();

    expect(result.imported).toBe(1);
    expect(mockImportSession).toHaveBeenCalledTimes(1);
  });

  it("обновляет существующие сессии", async () => {
    const fileData = mockSessionExport();
    const localMap = new Map([
      ["01JTEST00000000000000000001", mockSessionInfo()],
    ]);
    mockGetSessionMap.mockReturnValue(localMap);

    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    const result = await pullSessions();

    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("пропускает не новые сессии", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(false);

    const result = await pullSessions();

    expect(result.skipped).toBe(1);
    expect(mockImportSession).not.toHaveBeenCalled();
  });

  it("подсчитывает ошибки при чтении файлов", async () => {
    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["bad.json"],
    });
    mockReadSession.mockReturnValue(null);

    const result = await pullSessions();

    expect(result.errors).toBe(1);
  });

  it("подсчитывает ошибки при импорте", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(false);

    const result = await pullSessions();

    expect(result.errors).toBe(1);
  });

  it("продолжает после ошибки git pull", async () => {
    mockGitPull.mockImplementation(() => {
      throw new Error("network error");
    });
    mockFsStructure({});

    const result = await pullSessions();

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Ошибка при git pull"),
    );
    expect(result.imported).toBe(0);
  });

  it("dry-run показывает что будет импортировано", async () => {
    const fileData = mockSessionExport();
    const localMap = new Map([
      ["01JTEST00000000000000000001", mockSessionInfo()],
    ]);
    mockGetSessionMap.mockReturnValue(localMap);

    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);

    const result = await pullSessions({ dryRun: true });

    expect(result.imported).toBe(0);
    expect(result.updated).toBe(1);
    expect(mockImportSession).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("[dry-run]"),
    );
  });

  it("dry-run для новой сессии показывает 'импорт'", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);

    const result = await pullSessions({ dryRun: true });

    expect(result.imported).toBe(1);
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("импорт"),
    );
  });

  it("возвращает пустой результат если нет файлов", async () => {
    mockFsStructure({});

    const result = await pullSessions();

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("вызывает ensureRepo перед pull", async () => {
    mockFsStructure({});

    await pullSessions();

    expect(mockEnsureRepo).toHaveBeenCalledWith(
      mockConfig().repo,
      mockConfig().localPath,
      mockConfig().branch,
    );
  });

  it("вызывает git pull для подтягивания изменений", async () => {
    mockFsStructure({});

    await pullSessions();

    expect(mockGitPull).toHaveBeenCalledWith(
      mockConfig().localPath,
      mockConfig().branch,
    );
  });

  it("обрабатывает вложенные поддиректории", async () => {
    const fileData1 = mockSessionExport({ info: { ...mockSessionExport().info, id: "s1" } });
    const fileData2 = mockSessionExport({ info: { ...mockSessionExport().info, id: "s2" } });

    mockStatSync.mockImplementation(() => ({ isDirectory: () => true } as any));
    mockReaddirSync.mockImplementation((dir: any) => {
      const dirStr = String(dir);
      if (dirStr.endsWith("sessions")) {
        return [{ name: "proj1", isDirectory: () => true, isFile: () => false }];
      }
      if (dirStr.endsWith("proj1")) {
        return [
          { name: "s1.json", isDirectory: () => false, isFile: () => true },
          { name: "s2.json", isDirectory: () => false, isFile: () => true },
        ];
      }
      return [];
    });

    mockReadSession
      .mockReturnValueOnce(fileData1)
      .mockReturnValueOnce(fileData2);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    const result = await pullSessions();

    expect(result.imported).toBe(2);
  });

  it("выводит итог в stdout", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFsStructure({});

    await pullSessions();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Готово"),
    );

    logSpy.mockRestore();
  });

  it("пропускает не-JSON файлы в директории", async () => {
    mockStatSync.mockImplementation(() => ({ isDirectory: () => true } as any));
    mockReaddirSync.mockImplementation((dir: any) => {
      const dirStr = String(dir);
      if (dirStr.endsWith("sessions")) {
        return [{ name: "proj1", isDirectory: () => true, isFile: () => false }];
      }
      if (dirStr.endsWith("proj1")) {
        return [
          { name: "s1.json", isDirectory: () => false, isFile: () => true },
          { name: "readme.txt", isDirectory: () => false, isFile: () => true },
          { name: ".gitkeep", isDirectory: () => false, isFile: () => true },
        ];
      }
      return [];
    });

    const fileData = mockSessionExport();
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    const result = await pullSessions();

    expect(result.imported).toBe(1);
    expect(mockReadSession).toHaveBeenCalledTimes(1);
  });

  it("использует sessionId как fallback title", async () => {
    const fileData = mockSessionExport({ info: { ...mockSessionExport().info, title: "" } });
    mockFsStructure({
      "/tmp/sync/sessions": ["abc123"],
      "abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    await pullSessions();

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("01JTEST00000000000000000001"),
    );
  });

  it("принимает pre-loaded localMap", async () => {
    const localMap = new Map([["s1", mockSessionInfo({ id: "s1" })]]);
    mockFsStructure({});

    await pullSessions({ localMap });

    expect(mockGetSessionMap).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Локальных сессий: 1"),
    );
  });

  it("вызывает preflightCheck перед ensureRepo", async () => {
    mockFsStructure({});
    const callOrder: string[] = [];
    mockPreflightCheck.mockImplementation(async () => { callOrder.push("preflight"); });
    mockEnsureRepo.mockImplementation(() => { callOrder.push("ensureRepo"); });

    await pullSessions();

    expect(callOrder).toEqual(["preflight", "ensureRepo"]);
  });

  it("пробрасывает ошибку от preflightCheck", async () => {
    mockPreflightCheck.mockRejectedValue(new Error("Нет подключения к интернету"));

    await expect(pullSessions()).rejects.toThrow("Нет подключения к интернету");
    expect(mockEnsureRepo).not.toHaveBeenCalled();
  });
});
