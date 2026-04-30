import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConfig, mockScope, mockSessionExport, mockSessionInfo } from "./__tests__/helpers.js";
import { pullSessions } from "./pull.js";

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
    constructor(m: string, h: string) {
      super(m);
      this.hint = h;
    }
  },
}));

vi.mock("./util.js", () => ({
  log: vi.fn(),
  withLock: vi.fn((_, fn) => fn()),
}));

vi.mock("./manifest.js", () => ({
  getGlobalSessionSet: vi.fn(() => new Set()),
  readDeletedSet: vi.fn(() => new Set()),
  addToDeletedSet: vi.fn(),
  deviceManifestExists: vi.fn(() => true),
}));

vi.mock("./scope.js", () => ({
  scopeProjectId: vi.fn(() => "abc123"),
  detectProjectScope: vi.fn(),
}));

import { readdirSync, statSync } from "node:fs";
import { loadConfig, sessionsDir } from "./config.js";
import { ensureRepo, pull as gitPull, preflightCheck } from "./git.js";
import { addToDeletedSet, deviceManifestExists, getGlobalSessionSet, readDeletedSet } from "./manifest.js";
import { deleteSession, getSessionMap, importSession, isRemoteNewer, readSessionFromFile } from "./session.js";
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
const _mockWithLock = vi.mocked(withLock);
const mockGetGlobalSessionSet = vi.mocked(getGlobalSessionSet);
const mockReadDeletedSet = vi.mocked(readDeletedSet);
const mockAddToDeletedSet = vi.mocked(addToDeletedSet);
const mockDeviceManifestExists = vi.mocked(deviceManifestExists);
const mockDeleteSession = vi.mocked(deleteSession);

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
    vi.resetAllMocks();
    mockLoadConfig.mockReturnValue(mockConfig());
    mockSessionsDir.mockReturnValue("/tmp/sync/sessions");
    mockGetSessionMap.mockReturnValue(new Map());
    mockGitPull.mockReturnValue(true);
    mockEnsureRepo.mockReturnValue(undefined);
    mockDeviceManifestExists.mockReturnValue(true);
  });

  it("импортирует новые сессии", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    const result = await pullSessions({ scope: mockScope() });

    expect(result.imported).toBe(1);
    expect(mockImportSession).toHaveBeenCalledTimes(1);
  });

  it("обновляет существующие сессии", async () => {
    const fileData = mockSessionExport();
    const localMap = new Map([["01JTEST00000000000000000001", mockSessionInfo()]]);
    mockGetSessionMap.mockReturnValue(localMap);

    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    const result = await pullSessions({ scope: mockScope() });

    expect(result.updated).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("пропускает не новые сессии", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(false);

    const result = await pullSessions({ scope: mockScope() });

    expect(result.skipped).toBe(1);
    expect(mockImportSession).not.toHaveBeenCalled();
  });

  it("подсчитывает ошибки при чтении файлов", async () => {
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["bad.json"],
    });
    mockReadSession.mockReturnValue(null);

    const result = await pullSessions({ scope: mockScope() });

    expect(result.errors).toBe(1);
  });

  it("подсчитывает ошибки при импорте", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(false);

    const result = await pullSessions({ scope: mockScope() });

    expect(result.errors).toBe(1);
  });

  it("продолжает после ошибки git pull", async () => {
    mockGitPull.mockImplementation(() => {
      throw new Error("network error");
    });
    mockFsStructure({});

    const result = await pullSessions({ scope: mockScope() });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Ошибка при git pull"));
    expect(result.imported).toBe(0);
  });

  it("dry-run показывает что будет импортировано", async () => {
    const fileData = mockSessionExport();
    const localMap = new Map([["01JTEST00000000000000000001", mockSessionInfo()]]);
    mockGetSessionMap.mockReturnValue(localMap);

    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);

    const result = await pullSessions({ dryRun: true, scope: mockScope() });

    expect(result.imported).toBe(0);
    expect(result.updated).toBe(1);
    expect(mockImportSession).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("[dry-run]"));
  });

  it("dry-run для новой сессии показывает 'импорт'", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);

    const result = await pullSessions({ dryRun: true, scope: mockScope() });

    expect(result.imported).toBe(1);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("импорт"));
  });

  it("возвращает пустой результат если нет файлов", async () => {
    mockFsStructure({});

    const result = await pullSessions({ scope: mockScope() });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("вызывает ensureRepo перед pull", async () => {
    mockFsStructure({});

    await pullSessions({ scope: mockScope() });

    expect(mockEnsureRepo).toHaveBeenCalledWith(mockConfig().repo, mockConfig().localPath, mockConfig().branch);
  });

  it("вызывает git pull для подтягивания изменений", async () => {
    mockFsStructure({});

    await pullSessions({ scope: mockScope() });

    expect(mockGitPull).toHaveBeenCalledWith(mockConfig().localPath, mockConfig().branch);
  });

  it("использует sessionId как fallback title", async () => {
    const fileData = mockSessionExport({ info: { ...mockSessionExport().info, title: "" } });
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    await pullSessions({ scope: mockScope() });

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("01JTEST00000000000000000001"));
  });

  it("принимает pre-loaded localMap", async () => {
    const localMap = new Map([["s1", mockSessionInfo({ id: "s1" })]]);
    mockFsStructure({});

    await pullSessions({ localMap, scope: mockScope() });

    expect(mockGetSessionMap).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Локальных сессий: 1"));
  });

  it("вызывает preflightCheck перед ensureRepo", async () => {
    mockFsStructure({});
    const callOrder: string[] = [];
    mockPreflightCheck.mockImplementation(async () => {
      callOrder.push("preflight");
    });
    mockEnsureRepo.mockImplementation(() => {
      callOrder.push("ensureRepo");
    });

    await pullSessions({ scope: mockScope() });

    expect(callOrder).toEqual(["preflight", "ensureRepo"]);
  });

  it("пробрасывает ошибку от preflightCheck", async () => {
    mockPreflightCheck.mockRejectedValue(new Error("Нет подключения к интернету"));

    await expect(pullSessions({ scope: mockScope() })).rejects.toThrow("Нет подключения к интернету");
    expect(mockEnsureRepo).not.toHaveBeenCalled();
  });

  it("пропускает сессии из deleted set", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockReadDeletedSet.mockReturnValue(new Set(["01JTEST00000000000000000001"]));

    const result = await pullSessions({ scope: mockScope() });

    expect(result.skipped).toBe(1);
    expect(mockImportSession).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("deleted set"));
  });

  it("не удаляет локальные сессии при первом запуске (нет манифеста)", async () => {
    mockDeviceManifestExists.mockReturnValue(false);
    const localMap = new Map([["s1", mockSessionInfo({ id: "s1" })]]);
    mockGetSessionMap.mockReturnValue(localMap);
    mockGetGlobalSessionSet.mockReturnValue(new Set());
    mockFsStructure({});

    const result = await pullSessions({ scope: mockScope() });

    expect(result.deleted).toBe(0);
    expect(mockDeleteSession).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("первая синхронизация"));
  });

  it("удаляет локальные сессии если манифест существует и сессия не в globalAlive", async () => {
    const localMap = new Map([
      ["s1", mockSessionInfo({ id: "s1", projectId: "abc123" })],
      ["s2", mockSessionInfo({ id: "s2", projectId: "abc123" })],
    ]);
    mockGetSessionMap.mockReturnValue(localMap);
    mockGetGlobalSessionSet.mockReturnValue(new Set(["s2"]));
    mockDeleteSession.mockReturnValue(true);
    mockFsStructure({});

    const result = await pullSessions({ scope: mockScope() });

    expect(result.deleted).toBe(1);
    expect(mockDeleteSession).toHaveBeenCalledWith("s1");
    expect(mockAddToDeletedSet).toHaveBeenCalledWith(expect.any(String), expect.any(String), ["s1"]);
  });

  it("не удаляет сессии другого проекта при scoped pull", async () => {
    const localMap = new Map([
      ["s1", mockSessionInfo({ id: "s1", projectId: "abc123" })],
      ["s2", mockSessionInfo({ id: "s2", projectId: "other-project" })],
    ]);
    mockGetSessionMap.mockReturnValue(localMap);
    mockGetGlobalSessionSet.mockReturnValue(new Set());
    mockDeleteSession.mockReturnValue(true);
    mockFsStructure({});

    const result = await pullSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(mockDeleteSession).toHaveBeenCalledWith("s1");
    expect(mockDeleteSession).not.toHaveBeenCalledWith("s2");
    expect(result.deleted).toBe(1);
  });

  it("сканирует только scoped-папку при pull", async () => {
    const fileData = mockSessionExport();
    mockFsStructure({
      "/tmp/sync/sessions/abc123": ["s1.json"],
    });
    mockReadSession.mockReturnValue(fileData);
    mockIsRemoteNewer.mockReturnValue(true);
    mockImportSession.mockReturnValue(true);

    await pullSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(mockStatSync).toHaveBeenCalledWith(
      "/tmp/sync/sessions/abc123",
      expect.objectContaining({ throwIfNoEntry: false }),
    );
  });

  it("выводит итог в stdout", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFsStructure({});

    await pullSessions({ scope: mockScope() });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Готово"));

    logSpy.mockRestore();
  });
});
