import { describe, it, expect, vi, beforeEach } from "vitest";
import { pushSessions } from "./push.js";
import { mockSessionInfo, mockSessionExport, mockConfig } from "./__tests__/helpers.js";

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
}));

import { loadConfig, sessionsDir } from "./config.js";
import { listSessions, exportSessionAsync, saveSessionToFile, isLocalNewer, checkOpenCodeInstalled } from "./session.js";
import { ensureRepo, push as gitPush } from "./git.js";
import { log, promisePool, withLockAsync } from "./util.js";

const mockLoadConfig = vi.mocked(loadConfig);
const mockSessionsDir = vi.mocked(sessionsDir);
const mockListSessions = vi.mocked(listSessions);
const mockExportAsync = vi.mocked(exportSessionAsync);
const mockSaveSession = vi.mocked(saveSessionToFile);
const mockIsLocalNewer = vi.mocked(isLocalNewer);
const mockEnsureRepo = vi.mocked(ensureRepo);
const mockGitPush = vi.mocked(gitPush);
const mockLog = vi.mocked(log);
const mockPromisePool = vi.mocked(promisePool);
const mockWithLockAsync = vi.mocked(withLockAsync);

describe("push.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(mockConfig());
    mockSessionsDir.mockReturnValue("/tmp/sync/sessions");
  });

  it("экспортирует новые сессии и push'ит", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "Session 1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());

    const result = await pushSessions();

    expect(result.exported).toBe(1);
    expect(mockSaveSession).toHaveBeenCalled();
    expect(mockWithLockAsync).toHaveBeenCalled();
  });

  it("пропускает не изменённые сессии", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(false);

    const result = await pushSessions();

    expect(result.skipped).toBe(1);
    expect(result.exported).toBe(0);
    expect(mockExportAsync).not.toHaveBeenCalled();
  });

  it("подсчитывает ошибки при экспорте", async () => {
    const sessions = [
      mockSessionInfo({ id: "s1", title: "OK" }),
      mockSessionInfo({ id: "s2", title: "FAIL" }),
    ];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync
      .mockResolvedValueOnce(mockSessionExport())
      .mockRejectedValueOnce(new Error("export error"));

    const result = await pushSessions();

    expect(result.exported).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("пропускает сессии с null от exportSessionAsync", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "Broken" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(null);

    const result = await pushSessions();

    expect(result.skipped).toBe(1);
    expect(result.exported).toBe(0);
  });

  it("не push'ит если нет экспортированных сессий", async () => {
    mockListSessions.mockReturnValue([]);
    mockIsLocalNewer.mockReturnValue(false);

    const result = await pushSessions();

    expect(result.exported).toBe(0);
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it("dry-run показывает что будет экспортировано", async () => {
    const sessions = [mockSessionInfo({ id: "s1", title: "Session 1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);

    const result = await pushSessions({ dryRun: true });

    expect(result.exported).toBe(1);
    expect(mockExportAsync).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("[dry-run]"),
    );
  });

  it("dry-run не сохраняет файлы и не push'ит", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);

    await pushSessions({ dryRun: true });

    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it("вызывает ensureRepo перед работой", async () => {
    mockListSessions.mockReturnValue([]);

    await pushSessions();

    expect(mockEnsureRepo).toHaveBeenCalledWith(
      mockConfig().repo,
      mockConfig().localPath,
      mockConfig().branch,
    );
  });

  it("пропускает сессии с пустым id", async () => {
    const sessions = [mockSessionInfo({ id: "" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);

    const result = await pushSessions();

    expect(result.skipped).toBe(1);
    expect(mockExportAsync).not.toHaveBeenCalled();
  });

  it("выводит количество найденных сессий в stdout", async () => {
    mockListSessions.mockReturnValue([mockSessionInfo(), mockSessionInfo()]);
    mockIsLocalNewer.mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pushSessions();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("2 сессий"),
    );

    logSpy.mockRestore();
  });

  it("принимает pre-loaded sessions", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockIsLocalNewer.mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await pushSessions({ sessions });

    expect(mockListSessions).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 сессий"),
    );

    logSpy.mockRestore();
  });

  it("использует promisePool для параллельного экспорта", async () => {
    const sessions = [mockSessionInfo({ id: "s1" })];
    mockListSessions.mockReturnValue(sessions);
    mockIsLocalNewer.mockReturnValue(true);
    mockExportAsync.mockResolvedValue(mockSessionExport());

    await pushSessions();

    expect(mockPromisePool).toHaveBeenCalled();
  });
});
