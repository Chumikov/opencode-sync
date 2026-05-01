import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConfig, mockScope, mockSessionExport, mockSessionInfo } from "./__tests__/helpers.js";
import { pushSessions } from "./push.js";

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(),
  sessionsDir: vi.fn(),
}));

vi.mock("./session.js", () => ({
  listSessions: vi.fn(),
  exportSessionAsync: vi.fn(),
  saveSessionToFile: vi.fn(),
  isLocalNewer: vi.fn(),
  checkOpenCodeInstalled: vi.fn(() => true),
}));

vi.mock("./git.js", () => ({
  ensureRepo: vi.fn(),
  push: vi.fn(async () => {}),
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
  promisePool: vi.fn(async (items, _concurrency, fn) => {
    const results = [];
    for (const item of items) results.push(await fn(item));
    return results;
  }),
  EXPORT_CONCURRENCY: 5,
  withLockAsync: vi.fn(async (_, fn) => fn()),
}));

vi.mock("./manifest.js", () => ({
  writeManifest: vi.fn(),
  getGlobalSessionSet: vi.fn(() => new Set()),
  findOrphanFiles: vi.fn(() => []),
  readManifest: vi.fn(() => new Set()),
  addToDeletedSet: vi.fn(),
  deviceManifestExists: vi.fn(() => true),
}));

vi.mock("./scope.js", () => ({
  scopeProjectId: vi.fn(() => "abc123"),
  detectProjectScope: vi.fn(),
}));

import { loadConfig, sessionsDir } from "./config.js";
import { ensureRepo, push as gitPush, preflightCheck } from "./git.js";
import {
  addToDeletedSet,
  deviceManifestExists,
  findOrphanFiles,
  getGlobalSessionSet,
  readManifest,
  writeManifest,
} from "./manifest.js";
import { exportSessionAsync, isLocalNewer, listSessions, saveSessionToFile } from "./session.js";
import { log, promisePool, withLockAsync } from "./util.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockSessionsDir = vi.mocked(sessionsDir);
const mockListSessions = vi.mocked(listSessions);
const mockExportAsync = vi.mocked(exportSessionAsync);
const mockSaveSession = vi.mocked(saveSessionToFile);
const mockIsLocalNewer = vi.mocked(isLocalNewer);
const mockEnsureRepo = vi.mocked(ensureRepo);
const mockGitPush = vi.mocked(gitPush);
const mockPreflightCheck = vi.mocked(preflightCheck);
const mockLog = vi.mocked(log);
const mockPromisePool = vi.mocked(promisePool);
const mockWithLockAsync = vi.mocked(withLockAsync);
const mockReadManifest = vi.mocked(readManifest);
const mockWriteManifest = vi.mocked(writeManifest);
const mockGetGlobalSessionSet = vi.mocked(getGlobalSessionSet);
const mockFindOrphanFiles = vi.mocked(findOrphanFiles);
const mockAddToDeletedSet = vi.mocked(addToDeletedSet);
const mockDeviceManifestExists = vi.mocked(deviceManifestExists);

describe("push.ts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadConfig.mockReturnValue(mockConfig());
    mockSessionsDir.mockReturnValue("/tmp/sync/sessions");
    mockDeviceManifestExists.mockReturnValue(true);
  });

  it("экспортирует новые сессии и push'ит", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "Session 1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());

    const result = await pushSessions({ scope: mockScope() });

    expect(result.exported).toBe(1);
    expect(mockSaveSession).toHaveBeenCalled();
    expect(mockWithLockAsync).toHaveBeenCalled();
  });

  it("пропускает не изменённые сессии", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(false);

    const result = await pushSessions({ scope: mockScope() });

    expect(result.skipped).toBe(1);
    expect(result.exported).toBe(0);
    expect(mockExportAsync).not.toHaveBeenCalled();
  });

  it("подсчитывает ошибки при экспорте", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "OK" }), mockSessionInfo({ id: "s2", title: "FAIL" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValueOnce(mockSessionExport()).mockRejectedValueOnce(new Error("export error"));

    const result = await pushSessions({ scope: mockScope() });

    expect(result.exported).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("пропускает сессии с null от exportSessionAsync", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "Broken" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(null);

    const result = await pushSessions({ scope: mockScope() });

    expect(result.skipped).toBe(1);
    expect(result.exported).toBe(0);
  });

  it("не push'ит если нет экспортированных сессий", async () => {
    mockListSessions.mockReturnValue([]);
    mockIsLocalNewer.mockReturnValue(false);

    const result = await pushSessions({ scope: mockScope() });

    expect(result.exported).toBe(0);
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it("dry-run показывает что будет экспортировано", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "Session 1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);

    const result = await pushSessions({ dryRun: true, scope: mockScope() });

    expect(result.exported).toBe(1);
    expect(mockExportAsync).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("[dry-run]"));
  });

  it("dry-run не сохраняет файлы и не push'ит", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);

    await pushSessions({ dryRun: true, scope: mockScope() });

    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it("вызывает ensureRepo перед работой", async () => {
    mockListSessions.mockReturnValue([]);

    await pushSessions({ scope: mockScope() });

    expect(mockEnsureRepo).toHaveBeenCalledWith(mockConfig().repo, mockConfig().localPath, mockConfig().branch);
  });

  it("пропускает сессии с пустым id", async () => {
    const sessions = [mockSessionInfo({ id: "" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);

    const result = await pushSessions({ scope: mockScope() });

    expect(result.skipped).toBe(1);
    expect(mockExportAsync).not.toHaveBeenCalled();
  });

  it("выводит количество найденных сессий в stdout", async () => {
    mockListSessions.mockReturnValue([mockSessionInfo(), mockSessionInfo()]);
    mockIsLocalNewer.mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pushSessions({ scope: mockScope() });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2 сессий"));

    logSpy.mockRestore();
  });

  it("принимает pre-loaded sessions", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockIsLocalNewer.mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pushSessions({ sessions, scope: mockScope() });

    expect(mockListSessions).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 сессий"));

    logSpy.mockRestore();
  });

  it("использует promisePool для параллельного экспорта", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());

    await pushSessions({ scope: mockScope() });

    expect(mockPromisePool).toHaveBeenCalled();
  });

  it("вызывает preflightCheck перед ensureRepo", async () => {
    mockListSessions.mockReturnValue([]);
    const callOrder: string[] = [];
    mockPreflightCheck.mockImplementation(async () => {
      callOrder.push("preflight");
    });
    mockEnsureRepo.mockImplementation(() => {
      callOrder.push("ensureRepo");
    });

    await pushSessions({ scope: mockScope() });

    expect(callOrder).toEqual(["preflight", "ensureRepo"]);
  });

  it("пробрасывает PreflightError от preflightCheck", async () => {
    mockPreflightCheck.mockRejectedValue(new Error("Нет подключения к интернету"));

    await expect(pushSessions({ scope: mockScope() })).rejects.toThrow("Нет подключения к интернету");
    expect(mockEnsureRepo).not.toHaveBeenCalled();
  });

  it("фильтрует сессии по project scope", async () => {
    const sessions = [
      mockSessionInfo({ id: "s1", projectId: "abc123" }),
      mockSessionInfo({ id: "s2", projectId: "other" }),
      mockSessionInfo({ id: "s3", projectId: "global" }),
    ];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await pushSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(result.exported).toBe(1);
    expect(mockExportAsync).toHaveBeenCalledTimes(1);
    expect(mockExportAsync).toHaveBeenCalledWith("s1");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 сессий"));

    logSpy.mockRestore();
  });

  it("фильтрует сессии по global scope", async () => {
    const sessions = [
      mockSessionInfo({ id: "s1", projectId: "abc123" }),
      mockSessionInfo({ id: "s2", projectId: "global" }),
      mockSessionInfo({ id: "s3", projectId: "" }),
    ];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await pushSessions({ scope: { type: "global" } });

    expect(result.exported).toBe(2);
    expect(mockExportAsync).toHaveBeenCalledTimes(2);

    logSpy.mockRestore();
  });

  it("записывает полный манифест (все id, не только scope)", async () => {
    const sessions = [
      mockSessionInfo({ id: "s1", projectId: "abc123" }),
      mockSessionInfo({ id: "s2", projectId: "other" }),
    ];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(false);

    await pushSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(mockWriteManifest).toHaveBeenCalledWith(expect.any(String), expect.any(String), new Set(["s1", "s2"]));
  });

  it("отслеживает удалённые сессии — добавляет в deleted set", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockReadManifest.mockReturnValue(new Set(["s1", "s2", "s3"]));
    mockIsLocalNewer.mockReturnValue(false);

    await pushSessions({ scope: mockScope() });

    expect(mockAddToDeletedSet).toHaveBeenCalledWith(expect.any(String), expect.any(String), ["s2", "s3"]);
  });

  it("не вызывает addToDeletedSet если нет удалённых", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockReadManifest.mockReturnValue(new Set(["s1"]));
    mockIsLocalNewer.mockReturnValue(false);

    await pushSessions({ scope: mockScope() });

    expect(mockAddToDeletedSet).not.toHaveBeenCalled();
  });

  it("ищет orphan-файлы только в scoped-папке", async () => {
    mockListSessions.mockReturnValue([]);
    mockGetGlobalSessionSet.mockReturnValue(new Set());
    mockFindOrphanFiles.mockReturnValue([]);

    await pushSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(mockFindOrphanFiles).toHaveBeenCalledWith("/tmp/sync/sessions/abc123", expect.any(Set));
  });

  it("push'ит если есть удалённые сессии даже без экспорта", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockReadManifest.mockReturnValue(new Set(["s1", "s2"]));
    mockIsLocalNewer.mockReturnValue(false);

    await pushSessions({ scope: mockScope() });

    expect(mockGitPush).toHaveBeenCalled();
  });

  it("первый push (нет манифеста) экспортирует все сессии без фильтрации по scope", async () => {
    const sessions = [
      mockSessionInfo({ id: "s1", projectId: "abc123" }),
      mockSessionInfo({ id: "s2", projectId: "other" }),
      mockSessionInfo({ id: "s3", projectId: "global" }),
    ];
    mockListSessions.mockReturnValue(sessions);
    mockDeviceManifestExists.mockReturnValue(false);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await pushSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(result.exported).toBe(3);
    expect(mockExportAsync).toHaveBeenCalledTimes(3);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Первый push"));

    logSpy.mockRestore();
  });

  it("повторный push (манифест есть) фильтрует по scope", async () => {
    const sessions = [
      mockSessionInfo({ id: "s1", projectId: "abc123" }),
      mockSessionInfo({ id: "s2", projectId: "other" }),
    ];
    mockListSessions.mockReturnValue(sessions);
    mockDeviceManifestExists.mockReturnValue(true);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());

    const result = await pushSessions({ scope: mockScope({ type: "project", projectId: "abc123" }) });

    expect(result.exported).toBe(1);
    expect(mockExportAsync).toHaveBeenCalledTimes(1);
    expect(mockExportAsync).toHaveBeenCalledWith("s1");
  });
});
