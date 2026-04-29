import { beforeEach, describe, expect, it, vi } from "vitest";

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
  cloneAll: vi.fn(),
  maskUrl: vi.fn((u: string) => u),
  listBranches: vi.fn(() => []),
  listRemoteBranches: vi.fn(() => []),
  isGitRepo: vi.fn(() => false),
  checkRepoAccess: vi.fn(() => ({ ok: true })),
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

vi.mock("./session.js", () => ({
  checkOpenCodeInstalled: vi.fn(() => "opencode"),
}));

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  outro: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  })),
  isCancel: vi.fn(() => false),
}));

import { existsSync } from "node:fs";
import * as clack from "@clack/prompts";
import { saveConfig } from "./config.js";
import { checkRepoAccess, clone, cloneAll, isGitRepo, listBranches, listRemoteBranches, maskUrl } from "./git.js";
import { runSetup, SetupCancelledError, SetupFailedError } from "./setup.js";
import { installShellFunction } from "./shell.js";

describe("setup.ts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(checkRepoAccess).mockReturnValue({ ok: true });
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clone).mockImplementation(() => {});
    vi.mocked(installShellFunction).mockReturnValue({
      installed: true,
      rcFile: "/home/testuser/.zshrc",
      shellName: "zsh",
    });
    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.isCancel).mockReturnValue(false);
  });

  async function setupMocks(overrides: {
    configExists?: boolean;
    confirmResult?: boolean | symbol;
    repoUrl?: string | symbol;
    deviceName?: string | symbol;
    cloneError?: boolean;
    remoteBranches?: string[];
    branches?: string[];
    selectBranch?: string | symbol;
    shellInstalled?: boolean;
    accessResult?: { ok: true } | { ok: false; error: string; hint: string };
  }) {
    vi.mocked(existsSync).mockReturnValue(overrides.configExists ?? false);
    vi.mocked(clack.confirm).mockResolvedValue(overrides.confirmResult ?? false);

    const url = overrides.repoUrl ?? "git@github.com:user/sessions.git";
    const device = overrides.deviceName ?? "test-device";
    let textCallIdx = 0;
    const textResponses = [url, device];
    vi.mocked(clack.text).mockImplementation(() => {
      return Promise.resolve(textResponses[textCallIdx++]);
    });
    vi.mocked(clack.isCancel).mockReturnValue(false);

    if (overrides.accessResult) {
      vi.mocked(checkRepoAccess).mockReturnValue(overrides.accessResult);
    }

    if (overrides.cloneError) {
      vi.mocked(clone).mockImplementation(() => {
        throw new Error("clone failed");
      });
      vi.mocked(isGitRepo).mockReturnValue(true);
      vi.mocked(listRemoteBranches).mockReturnValue(overrides.remoteBranches ?? overrides.branches ?? []);
      vi.mocked(listBranches).mockReturnValue(overrides.branches ?? []);
      if ((overrides.remoteBranches ?? overrides.branches ?? []).length > 1) {
        vi.mocked(clack.select).mockResolvedValue(
          overrides.selectBranch ?? (overrides.remoteBranches ?? overrides.branches!)[0],
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

    expect(checkRepoAccess).toHaveBeenCalledWith("git@github.com:user/sessions.git");
    expect(clone).toHaveBeenCalledWith("git@github.com:user/sessions.git", expect.any(String), "main");
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

  it("показывает ошибку и hint при отсутствии доступа", async () => {
    await setupMocks({
      accessResult: {
        ok: false,
        error: "Нет SSH-доступа",
        hint: "ssh -T git@github.com",
      },
    });

    vi.mocked(clack.select).mockResolvedValue("cancel");

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
    expect(clack.log.error).toHaveBeenCalledWith("Нет SSH-доступа");
    expect(clack.note).toHaveBeenCalledWith("ssh -T git@github.com", "Как исправить");
  });

  it("повторяет проверку при выборе retry", async () => {
    vi.mocked(checkRepoAccess)
      .mockReturnValueOnce({ ok: false, error: "Нет доступа", hint: "Проверьте SSH" })
      .mockReturnValue({ ok: true });

    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clone).mockImplementation(() => {});
    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/sessions.git")
      .mockResolvedValueOnce("test-device");
    vi.mocked(clack.isCancel).mockReturnValue(false);
    vi.mocked(clack.select).mockResolvedValueOnce("retry");

    await runSetup();

    expect(checkRepoAccess).toHaveBeenCalledTimes(2);
    expect(clone).toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalled();
  });

  it("позволяет изменить URL и повторить", async () => {
    vi.mocked(checkRepoAccess)
      .mockReturnValueOnce({ ok: false, error: "Нет доступа", hint: "Проверьте" })
      .mockReturnValue({ ok: true });

    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clone).mockImplementation(() => {});
    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/old.git")
      .mockResolvedValueOnce("git@github.com:user/new.git")
      .mockResolvedValueOnce("test-device");
    vi.mocked(clack.isCancel).mockReturnValue(false);
    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.select).mockResolvedValueOnce("change");

    await runSetup();

    expect(checkRepoAccess).toHaveBeenCalledWith("git@github.com:user/old.git");
    expect(checkRepoAccess).toHaveBeenCalledWith("git@github.com:user/new.git");
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ repo: "git@github.com:user/new.git" }));
  });

  it("выходит при отмене из меню ошибки доступа", async () => {
    await setupMocks({
      accessResult: {
        ok: false,
        error: "Нет доступа",
        hint: "Проверьте",
      },
    });

    vi.mocked(clack.select).mockResolvedValue("cancel");

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("выходит при cancel (clack.isCancel) из меню ошибки", async () => {
    await setupMocks({
      accessResult: {
        ok: false,
        error: "Нет доступа",
        hint: "Проверьте",
      },
    });

    let cancelCount = 0;
    vi.mocked(clack.isCancel).mockImplementation(() => ++cancelCount >= 2);
    vi.mocked(clack.select).mockResolvedValue("retry");

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
  });

  it("выходит при cancel при вводе нового URL", async () => {
    vi.mocked(checkRepoAccess).mockReturnValue({
      ok: false,
      error: "Нет доступа",
      hint: "Проверьте",
    });

    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/sessions.git")
      .mockResolvedValueOnce(Symbol("cancel"));
    let cancelCount = 0;
    vi.mocked(clack.isCancel).mockImplementation((val: any) => {
      cancelCount++;
      return typeof val === "symbol" || cancelCount >= 3;
    });
    vi.mocked(clack.select).mockResolvedValue("change");

    await expect(runSetup()).rejects.toThrow(SetupCancelledError);
  });

  it("выбирает ветку при нескольких ветках", async () => {
    let cloneCallCount = 0;
    vi.mocked(clone).mockImplementation(() => {
      cloneCallCount++;
      if (cloneCallCount === 1) throw new Error("clone failed");
    });
    vi.mocked(isGitRepo).mockReturnValue(true);
    vi.mocked(listRemoteBranches).mockReturnValue(["main", "dev", "staging"]);
    vi.mocked(clack.select).mockResolvedValue("dev");
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/sessions.git")
      .mockResolvedValueOnce("test-device");
    vi.mocked(clack.isCancel).mockReturnValue(false);

    await runSetup();

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ branch: "dev" }));
  });

  it("берёт единственную ветку автоматически", async () => {
    let cloneCallCount = 0;
    vi.mocked(clone).mockImplementation(() => {
      cloneCallCount++;
      if (cloneCallCount === 1) throw new Error("clone failed");
    });
    vi.mocked(isGitRepo).mockReturnValue(true);
    vi.mocked(listRemoteBranches).mockReturnValue(["develop"]);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(clack.confirm).mockResolvedValue(false);
    vi.mocked(clack.text)
      .mockResolvedValueOnce("git@github.com:user/sessions.git")
      .mockResolvedValueOnce("test-device");
    vi.mocked(clack.isCancel).mockReturnValue(false);

    await runSetup();

    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ branch: "develop" }));
  });

  it("выходит если клонирование не удалось и репо не существует", async () => {
    vi.mocked(clone).mockImplementation(() => {
      throw new Error("clone failed");
    });
    vi.mocked(cloneAll).mockImplementation(() => {
      throw new Error("clone failed");
    });
    vi.mocked(isGitRepo).mockReturnValue(false);
    vi.mocked(listRemoteBranches).mockReturnValue([]);
    vi.mocked(existsSync).mockReturnValue(false);
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
