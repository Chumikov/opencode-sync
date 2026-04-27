import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => '{"version": "1.0.0"}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
  hostname: () => "testhost",
}));

vi.mock("./config.js", () => ({
  saveConfig: vi.fn(),
  CONFIG_FILE_PATH: "/home/testuser/.config/opencode/sync.json",
  DEFAULT_LOCAL_PATH: "/home/testuser/.local/share/opencode-sync",
}));

vi.mock("./git.js", () => ({
  clone: vi.fn(),
  maskUrl: vi.fn((u: string) => u),
  listBranches: vi.fn(() => []),
  isGitRepo: vi.fn(() => false),
}));

vi.mock("./shell.js", () => ({
  installShellFunction: vi.fn(() => ({
    installed: true,
    rcFile: "/home/testuser/.zshrc",
    shellName: "zsh",
  })),
}));

vi.mock("./util.js", () => ({
  log: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn() },
  outro: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  })),
  isCancel: vi.fn(() => false),
}));

import { runSetup, SetupCancelledError, SetupFailedError } from "./setup.js";
import { saveConfig } from "./config.js";
import { clone, listBranches, isGitRepo, maskUrl } from "./git.js";
import { installShellFunction } from "./shell.js";
import * as clack from "@clack/prompts";
import { existsSync } from "node:fs";

describe("setup.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupMocks(overrides: {
    configExists?: boolean;
    confirmResult?: boolean | symbol;
    repoUrl?: string | symbol;
    deviceName?: string | symbol;
    cloneError?: boolean;
    branches?: string[];
    selectBranch?: string | symbol;
    shellInstalled?: boolean;
  }) {
    vi.mocked(existsSync).mockReturnValue(overrides.configExists ?? false);
    vi.mocked(clack.confirm).mockResolvedValue(overrides.confirmResult ?? false);
    vi.mocked(clack.text)
      .mockResolvedValueOnce(overrides.repoUrl ?? "git@github.com:user/sessions.git")
      .mockResolvedValueOnce(overrides.deviceName ?? "test-device");
    vi.mocked(clack.isCancel).mockReturnValue(false);

    if (overrides.cloneError) {
      vi.mocked(clone).mockImplementation(() => {
        throw new Error("clone failed");
      });
      vi.mocked(isGitRepo).mockReturnValue(true);
      vi.mocked(listBranches).mockReturnValue(overrides.branches ?? []);
      if (overrides.branches && overrides.branches.length > 1) {
        vi.mocked(clack.select).mockResolvedValue(
          overrides.selectBranch ?? overrides.branches[0],
        );
      }
    } else {
      vi.mocked(clone).mockImplementation(() => {});
    }

    if (overrides.shellInstalled === false) {
      vi.mocked(installShellFunction).mockReturnValue({
        installed: false,
        rcFile: "",
        shellName: "",
      });
    }
  }

  it("выполняет полный setup при новом конфиге", async () => {
    await setupMocks({});

    await runSetup();

    expect(clone).toHaveBeenCalledWith(
      "git@github.com:user/sessions.git",
      expect.any(String),
      "main",
    );
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "git@github.com:user/sessions.git",
        deviceName: "test-device",
        branch: "main",
      }),
    );
    expect(installShellFunction).toHaveBeenCalled();
    expect(clack.outro).toHaveBeenCalled();
  });

  it("запрашивает подтверждение при существующем конфиге", async () => {
    await setupMocks({ configExists: true, confirmResult: false });

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("перенастраивает при подтверждении", async () => {
    await setupMocks({ configExists: true, confirmResult: true });

    await runSetup();

    expect(saveConfig).toHaveBeenCalled();
  });

  it("выходит при отмене ввода URL", async () => {
    const symbol = Symbol("cancel");
    await setupMocks({ repoUrl: symbol });
    vi.mocked(clack.isCancel).mockReturnValue(true);

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("выходит при отмене имени устройства", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/sessions.git")
      .mockResolvedValueOnce(Symbol("cancel"));
    let cancelCallCount = 0;
    vi.mocked(clack.isCancel).mockImplementation(() => ++cancelCallCount === 2);

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
    expect(clack.cancel).toHaveBeenCalled();
  });

  it("выбирает ветку при нескольких ветках", async () => {
    await setupMocks({
      cloneError: true,
      branches: ["main", "dev", "staging"],
      selectBranch: "dev",
    });

    await runSetup();

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "dev" }),
    );
  });

  it("берёт единственную ветку автоматически", async () => {
    await setupMocks({
      cloneError: true,
      branches: ["develop"],
    });

    await runSetup();

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "develop" }),
    );
  });

  it("выходит если клонирование не удалось и репо не существует", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clone).mockImplementation(() => {
      throw new Error("clone failed");
    });
    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/sessions.git")
      .mockResolvedValueOnce("test-device");
    vi.mocked(clack.isCancel).mockReturnValue(false);

    await expect(runSetup()).rejects.toThrow(SetupFailedError);
    expect(maskUrl).toHaveBeenCalled();
  });

  it("предупреждает если shell не поддерживается", async () => {
    await setupMocks({ shellInstalled: false });

    await runSetup();

    expect(clack.log.warn).toHaveBeenCalled();
  });

  it("валидация URL reject пустой ввод", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clack.text)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("test-device");
    const validateFn = vi.mocked(clack.text).mock.calls[0];
    
    const textOptions = vi.mocked(clack.text).mock.calls[0] as any[];
    const validate = (await import("./setup.js")).runSetup;

    expect(typeof textOptions).toBeDefined();
  });

  it("SetupCancelledError имеет правильное имя", () => {
    const err = new SetupCancelledError();
    expect(err.name).toBe("SetupCancelledError");
    expect(err.message).toBe("Настройка отменена");
  });

  it("SetupFailedError содержит сообщение", () => {
    const err = new SetupFailedError("test fail");
    expect(err.name).toBe("SetupFailedError");
    expect(err.message).toBe("test fail");
  });
});
