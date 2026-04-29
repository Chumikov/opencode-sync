import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConfig } from "./config.js";
import { CONFIG_FILE_PATH, DEFAULT_LOCAL_PATH, loadConfig, saveConfig, sessionsDir } from "./config.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
  hostname: () => "testhost",
}));

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const validConfigJson = JSON.stringify({
  repo: "git@github.com:user/sync.git",
  deviceName: "my-laptop",
  localPath: "/home/testuser/.local/share/opencode-sync",
  branch: "main",
});

describe("config.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCODE_SYNC_REPO;
    delete process.env.OPENCODE_SYNC_DEVICE;
    delete process.env.OPENCODE_SYNC_PATH;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
  });

  describe("constants", () => {
    it("CONFIG_FILE_PATH следует XDG-спецификации", () => {
      expect(CONFIG_FILE_PATH).toMatch(/\.(config|Config)[\\/]opencode[\\/]sync\.json$/);
    });

    it("DEFAULT_LOCAL_PATH следует XDG-спецификации", () => {
      expect(DEFAULT_LOCAL_PATH).toMatch(/\.(local|Local)[\\/]share[\\/]opencode-sync$/);
    });
  });

  describe("loadConfig", () => {
    it("загружает конфигурацию из файла", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(validConfigJson);

      const config = loadConfig();

      expect(config.repo).toBe("git@github.com:user/sync.git");
      expect(config.deviceName).toBe("my-laptop");
      expect(config.branch).toBe("main");
    });

    it("env-переменные имеют приоритет над файлом", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(validConfigJson);

      process.env.OPENCODE_SYNC_REPO = "git@github.com:override/repo.git";
      process.env.OPENCODE_SYNC_DEVICE = "override-device";
      process.env.OPENCODE_SYNC_PATH = "/tmp/override-path";

      const config = loadConfig();

      expect(config.repo).toBe("git@github.com:override/repo.git");
      expect(config.deviceName).toBe("override-device");
      expect(config.localPath).toBe(resolve("/tmp/override-path"));
    });

    it("бросает ошибку если repo не указан", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => loadConfig()).toThrow("Не указан git-репозиторий");
    });

    it("использует hostname как fallback для deviceName", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ repo: "git@github.com:user/repo.git" }));

      const config = loadConfig();

      expect(config.deviceName).toBe("testhost");
    });

    it("использует DEFAULT_LOCAL_PATH как fallback", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ repo: "git@github.com:user/repo.git" }));

      const config = loadConfig();

      expect(config.localPath).toBe(resolve(DEFAULT_LOCAL_PATH));
    });

    it("использует main как fallback для branch", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ repo: "git@github.com:user/repo.git" }));

      const config = loadConfig();

      expect(config.branch).toBe("main");
    });

    it("игнорирует битый конфиг-файл с предупреждением", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("NOT VALID JSON {{{");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      process.env.OPENCODE_SYNC_REPO = "git@github.com:user/repo.git";

      const config = loadConfig();

      expect(config.repo).toBe("git@github.com:user/repo.git");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Не удалось прочитать"));

      warnSpy.mockRestore();
    });

    it("разрешает relative localPath через resolve", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          repo: "git@github.com:user/repo.git",
          localPath: "relative/path",
        }),
      );

      const config = loadConfig();

      expect(config.localPath).toMatch(/^[A-Z]:\\|^\/|^\//);
    });
  });

  describe("saveConfig", () => {
    it("сохраняет конфигурацию в JSON-файл", () => {
      const config: SyncConfig = {
        repo: "git@github.com:user/sync.git",
        deviceName: "my-device",
        localPath: "/tmp/test",
        branch: "main",
      };

      vi.mocked(existsSync).mockReturnValue(false);

      saveConfig(config);

      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      });
      expect(writeFileSync).toHaveBeenCalledWith(CONFIG_FILE_PATH, expect.any(String), "utf-8");
      expect(chmodSync).toHaveBeenCalledWith(CONFIG_FILE_PATH, 0o600);
    });

    it("записывает валидный JSON с переносом строки", () => {
      const config: SyncConfig = {
        repo: "git@github.com:user/sync.git",
        deviceName: "my-device",
        localPath: "/tmp/test",
        branch: "main",
      };

      vi.mocked(existsSync).mockReturnValue(true);

      saveConfig(config);

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(written.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(written)).not.toThrow();
    });

    it("не создаёт директорию если она уже существует", () => {
      const config: SyncConfig = {
        repo: "git@github.com:user/sync.git",
        deviceName: "my-device",
        localPath: "/tmp/test",
        branch: "main",
      };

      vi.mocked(existsSync).mockReturnValue(true);

      saveConfig(config);

      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it("логирует сообщение о сохранении", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.mocked(existsSync).mockReturnValue(true);

      saveConfig({
        repo: "git@github.com:user/sync.git",
        deviceName: "dev",
        localPath: "/tmp",
        branch: "main",
      });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Конфигурация сохранена"));

      logSpy.mockRestore();
    });
  });

  describe("sessionsDir", () => {
    it("возвращает путь sessions внутри basePath", () => {
      expect(sessionsDir("/tmp/sync")).toBe(join("/tmp/sync", "sessions"));
    });

    it("корректно обрабатывает пути с trailing slash (path.join нормализует)", () => {
      expect(sessionsDir("/tmp/sync/")).toBe(join("/tmp/sync", "sessions"));
    });
  });

  describe("XDG env overrides", () => {
    it("XDG_CONFIG_HOME влияет на CONFIG_FILE_PATH", () => {
      process.env.XDG_CONFIG_HOME = "/custom/config";
      vi.resetModules();
    });
  });
});
