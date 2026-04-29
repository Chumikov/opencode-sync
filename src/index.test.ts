import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => '{"version": "1.0.0"}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(() => ({
    repo: "git@github.com:user/sync.git",
    deviceName: "test-device",
    localPath: "/tmp/sync",
    branch: "main",
  })),
  saveConfig: vi.fn(),
  CONFIG_FILE_PATH: "/home/test/.config/opencode/sync.json",
  DEFAULT_LOCAL_PATH: "/home/test/.local/share/opencode-sync",
}));

vi.mock("./push.js", () => ({
  pushSessions: vi.fn(async () => ({
    exported: 0,
    skipped: 0,
    errors: 0,
  })),
}));

vi.mock("./pull.js", () => ({
  pullSessions: vi.fn(async () => ({
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  })),
}));

vi.mock("./git.js", () => ({
  isGitRepo: vi.fn(() => true),
  ensureRepo: vi.fn(),
  pull: vi.fn(() => true),
  push: vi.fn(),
  maskUrl: vi.fn((u: string) => u),
  checkRepoAccess: vi.fn(() => ({ ok: true })),
  preflightCheck: vi.fn(async () => {}),
  PreflightError: class PreflightError extends Error {
    hint: string;
    constructor(m: string, h: string) {
      super(m);
      this.hint = h;
    }
  },
}));

vi.mock("./session.js", () => ({
  listSessions: vi.fn(() => []),
  exportSession: vi.fn(),
  exportSessionAsync: vi.fn(),
  saveSessionToFile: vi.fn(),
  isLocalNewer: vi.fn(() => true),
  getSessionMap: vi.fn(() => new Map()),
  readSessionFromFile: vi.fn(),
  importSession: vi.fn(),
  isRemoteNewer: vi.fn(() => true),
}));

vi.mock("./util.js", () => ({
  log: vi.fn(),
  withRetry: vi.fn((fn) => fn()),
  withLock: vi.fn((_, fn) => fn()),
  withLockAsync: vi.fn(async (_, fn) => fn()),
  promisePool: vi.fn(),
  EXPORT_CONCURRENCY: 5,
  validateSessionId: vi.fn(),
  OPENCODE_TIMEOUT_MS: 30_000,
  OPENCODE_MAX_BUFFER: 50 * 1024 * 1024,
  GIT_TIMEOUT_MS: 60_000,
  GIT_MAX_BUFFER: 20 * 1024 * 1024,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 1000,
  LOCKFILE_NAME: ".opencode-sync.lock",
  SESSION_ID_RE: /^[a-zA-Z0-9_]+$/,
}));

vi.mock("./banner.js", () => ({
  printBanner: vi.fn(),
  getBanner: vi.fn(() => "banner"),
  VERSION: "1.0.0",
}));

vi.mock("./setup.js", () => ({
  runSetup: vi.fn(async () => {}),
  SetupCancelledError: class SetupCancelledError extends Error {},
  SetupFailedError: class SetupFailedError extends Error {},
}));

describe("index.ts CLI", () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalArgv = process.argv;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  });

  async function runCommand(args: string[]): Promise<void> {
    process.argv = ["node", "opencode-sync", ...args];
    vi.resetModules();
    try {
      await import("./index.js");
    } catch (_err: any) {}
  }

  describe("setup", () => {
    it("вызывает printBanner и runSetup", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await runCommand(["setup"]);

      const { printBanner } = await import("./banner.js");
      expect(vi.mocked(printBanner)).toHaveBeenCalled();

      const { runSetup } = await import("./setup.js");
      expect(vi.mocked(runSetup)).toHaveBeenCalled();

      logSpy.mockRestore();
    });
  });

  describe("push", () => {
    it("вызывает pushSessions с dryRun=false", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runCommand(["push"]);

      const { pushSessions } = await import("./push.js");
      expect(vi.mocked(pushSessions)).toHaveBeenCalledWith({ dryRun: undefined });

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("dry-run передаёт флаг", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runCommand(["push", "--dry-run"]);

      const { pushSessions } = await import("./push.js");
      expect(vi.mocked(pushSessions)).toHaveBeenCalledWith({ dryRun: true });

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("pull", () => {
    it("вызывает pullSessions с dryRun=false", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runCommand(["pull"]);

      const { pullSessions } = await import("./pull.js");
      expect(vi.mocked(pullSessions)).toHaveBeenCalledWith({ dryRun: undefined });

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("dry-run передаёт флаг", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runCommand(["pull", "--dry-run"]);

      const { pullSessions } = await import("./pull.js");
      expect(vi.mocked(pullSessions)).toHaveBeenCalledWith({ dryRun: true });

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("sync", () => {
    it("вызывает pullSessions и pushSessions", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runCommand(["sync"]);

      const { pullSessions } = await import("./pull.js");
      const { pushSessions } = await import("./push.js");
      expect(vi.mocked(pullSessions)).toHaveBeenCalled();
      expect(vi.mocked(pushSessions)).toHaveBeenCalled();

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe("status", () => {
    it("показывает текущую конфигурацию", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await runCommand(["status"]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Конфиг:"));

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("показывает Remote доступ: ok при успешной проверке", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await runCommand(["status"]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Remote доступ:  ok"));

      logSpy.mockRestore();
    });

    it("показывает ошибку доступа при неудачной проверке", async () => {
      const { checkRepoAccess } = await import("./git.js");
      vi.mocked(checkRepoAccess).mockReturnValue({
        ok: false,
        error: "Нет SSH-доступа",
        hint: "ssh -T git@github.com",
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await runCommand(["status"]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Нет SSH-доступа"));

      logSpy.mockRestore();
    });
  });
});
