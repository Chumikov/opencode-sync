import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRepoAccess,
  clone,
  cloneAll,
  commit,
  ensureRepo,
  getDefaultBranch,
  isGitRepo,
  listBranches,
  listRemoteBranches,
  maskUrl,
  PreflightError,
  preflightCheck,
  pull,
  push,
} from "./git.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("./util.js", () => ({
  GIT_TIMEOUT_MS: 60_000,
  GIT_MAX_BUFFER: 20 * 1024 * 1024,
  log: vi.fn(),
  withRetry: vi.fn((fn) => fn()),
}));

vi.mock("./net.js", () => ({
  checkInternet: vi.fn(),
}));

vi.mock("./config.js", () => ({
  SyncConfig: undefined,
}));

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { checkInternet } from "./net.js";

const mockGit = vi.mocked(execFileSync);
const mockCheckInternet = vi.mocked(checkInternet);

describe("git.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("maskUrl", () => {
    it("маскирует SSH-URL", () => {
      expect(maskUrl("git@github.com:user/repo.git")).toBe("git@github.com:***");
    });

    it("маскирует HTTPS-URL с токеном", () => {
      expect(maskUrl("https://user:token@github.com/user/repo.git")).toBe("https://***:***@github.com/user/repo.git");
    });

    it("не изменяет HTTPS-URL без credentials", () => {
      expect(maskUrl("https://github.com/user/repo.git")).toBe("https://github.com/user/repo.git");
    });

    it("маскирует невалидный URL", () => {
      expect(maskUrl("not-a-url")).toBe("***");
    });

    it("маскирует HTTPS-URL только с username", () => {
      const result = maskUrl("https://user@github.com/repo.git");
      expect(result).toContain("***");
    });
  });

  describe("isGitRepo", () => {
    it("возвращает true для директории с .git", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      expect(isGitRepo("/tmp/myrepo")).toBe(true);
    });

    it("возвращает false для обычной директории", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(isGitRepo("/tmp/notrepo")).toBe(false);
    });
  });

  describe("clone", () => {
    it("вызывает git clone и создаёт .gitignore", () => {
      mockGit.mockReturnValue("");
      vi.mocked(existsSync).mockReturnValue(false);

      clone("git@github.com:user/repo.git", "/tmp/clone", "main");

      expect(mockGit).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["clone"]), expect.any(Object));
    });

    it("бросает ошибку при неудачном clone", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal: repo not found"), {
          stderr: "fatal: repository not found",
        });
      });

      expect(() => clone("git@github.com:no/repo.git", "/tmp/x", "main")).toThrow();
    });
  });

  describe("cloneAll", () => {
    it("клонирует без --single-branch", () => {
      mockGit.mockReturnValue("");
      vi.mocked(existsSync).mockReturnValue(false);

      cloneAll("git@github.com:user/repo.git", "/tmp/clone");

      expect(mockGit).toHaveBeenCalledWith(
        expect.any(String),
        ["clone", "git@github.com:user/repo.git", "/tmp/clone"],
        expect.any(Object),
      );
    });
  });

  describe("listRemoteBranches", () => {
    it("парсит ветки из ls-remote", () => {
      mockGit.mockReturnValue("a1b2c3d4\trefs/heads/main\ne5f6a7b8\trefs/heads/develop\n");

      const branches = listRemoteBranches("git@github.com:user/repo.git");

      expect(branches).toEqual(["main", "develop"]);
    });

    it("возвращает пустой массив при ошибке", () => {
      mockGit.mockImplementation(() => {
        throw new Error("failed");
      });

      expect(listRemoteBranches("git@github.com:user/repo.git")).toEqual([]);
    });
  });

  describe("ensureRepo", () => {
    it("клонирует если репозиторий не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      mockGit.mockReturnValue("");

      ensureRepo("git@github.com:user/repo.git", "/tmp/new", "main");

      expect(mockGit).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["clone"]), expect.any(Object));
    });

    it("обновляет remote URL если не совпадает", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockGit.mockReturnValueOnce("git@github.com:old/repo.git\n").mockReturnValueOnce("");

      ensureRepo("git@github.com:new/repo.git", "/tmp/existing", "main");

      const setUrlCall = mockGit.mock.calls.find((c) => (c[1] as string[]).includes("set-url"));
      expect(setUrlCall).toBeDefined();
    });

    it("добавляет remote если origin не существует", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockGit
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("no remote"), { stderr: "" });
        })
        .mockReturnValueOnce("");

      ensureRepo("git@github.com:user/repo.git", "/tmp/existing", "main");

      const addCall = mockGit.mock.calls.find((c) => (c[1] as string[]).includes("add"));
      expect(addCall).toBeDefined();
    });

    it("не делает ничего если remote совпадает", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockGit.mockReturnValue("git@github.com:user/repo.git\n");

      ensureRepo("git@github.com:user/repo.git", "/tmp/existing", "main");

      expect(mockGit).toHaveBeenCalledTimes(1);
    });
  });

  describe("pull", () => {
    it("возвращает true если есть новые изменения", () => {
      mockGit.mockReturnValue("Updating abc..def\nFast-forward\n");

      const result = pull("/tmp/repo", "main");

      expect(result).toBe(true);
    });

    it("возвращает false если уже актуально", () => {
      mockGit.mockReturnValue("Already up to date.");

      const result = pull("/tmp/repo", "main");

      expect(result).toBe(false);
    });

    it("бросает ошибку при merge-конфликте", () => {
      mockGit.mockImplementationOnce(() => {
        throw Object.assign(new Error("CONFLICT"), {
          stderr: "CONFLICT (content): Merge conflict in sessions/a/b.json",
        });
      });
      mockGit.mockReturnValueOnce("");

      expect(() => pull("/tmp/repo", "main")).toThrow("Merge-конфликт");
    });

    it("бросает оригинальную ошибку если это не конфликт", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("network error"), {
          stderr: "fatal: unable to access",
        });
      });

      expect(() => pull("/tmp/repo", "main")).toThrow("unable to access");
    });

    it("использует --rebase с --strategy-option theirs", () => {
      mockGit.mockReturnValue("Already up to date.");

      pull("/tmp/repo", "main");

      expect(mockGit).toHaveBeenCalledWith(
        expect.any(String),
        ["pull", "--rebase", "--strategy-option", "theirs", "origin", "main"],
        expect.any(Object),
      );
    });
  });

  describe("commit", () => {
    it("создаёт коммит если есть изменения", () => {
      mockGit
        .mockReturnValueOnce("")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("diff"), { status: 1 });
        })
        .mockReturnValueOnce("");

      const result = commit("/tmp/repo", "my-device");

      expect(result).toBe(true);
      expect(mockGit).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["add", "--all"]),
        expect.any(Object),
      );
      expect(mockGit).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["commit", "-m"]),
        expect.any(Object),
      );
    });

    it("возвращает false если нет изменений", () => {
      mockGit.mockReturnValueOnce("").mockReturnValueOnce("");

      const result = commit("/tmp/repo", "my-device");

      expect(result).toBe(false);
    });

    it("включает timestamp в коммит-сообщение", () => {
      const before = Date.now();

      mockGit
        .mockReturnValueOnce("")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("diff"), { status: 1 });
        })
        .mockReturnValueOnce("");

      commit("/tmp/repo", "dev");

      const commitCall = mockGit.mock.calls.find((c) => (c[1] as string[]).includes("commit"));
      const msg = (commitCall?.[1] as string[])[2] as string;
      const after = Date.now();
      const tsStr = msg.replace("sync: dev @ ", "");
      const ts = new Date(tsStr).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe("push", () => {
    it("push'ит если есть коммит", async () => {
      mockGit
        .mockReturnValueOnce("Already up to date.")
        .mockReturnValueOnce("")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("diff"), { status: 1 });
        })
        .mockReturnValueOnce("")
        .mockReturnValueOnce("");

      await push("/tmp/repo", "main", "my-device");

      const pushCall = mockGit.mock.calls.find((c) => (c[1] as string[]).includes("push"));
      expect(pushCall).toBeDefined();
    });

    it("продолжает push даже если pull падает", async () => {
      const { withRetry } = await import("./util.js");
      vi.mocked(withRetry).mockImplementationOnce(async () => {
        throw new Error("pull fail");
      });

      mockGit
        .mockReturnValueOnce("")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("diff"), { status: 1 });
        })
        .mockReturnValueOnce("")
        .mockReturnValueOnce("");

      await push("/tmp/repo", "main", "my-device");

      const pushCall = mockGit.mock.calls.find((c) => (c[1] as string[]).includes("push"));
      expect(pushCall).toBeDefined();
    });

    it("не push'ит если нет изменений", async () => {
      mockGit.mockReturnValueOnce("Already up to date.").mockReturnValueOnce("").mockReturnValueOnce("");

      await push("/tmp/repo", "main", "my-device");

      const pushCall = mockGit.mock.calls.find((c) => (c[1] as string[])[0] === "push");
      expect(pushCall).toBeUndefined();
    });
  });

  describe("listBranches", () => {
    it("возвращает список веток без origin/ и HEAD", () => {
      mockGit.mockReturnValue("  origin/main\n  origin/develop\n  origin/HEAD -> origin/main\n");

      const branches = listBranches("/tmp/repo");

      expect(branches).toEqual(["main", "develop"]);
    });

    it("возвращает пустой массив при ошибке", () => {
      mockGit.mockImplementation(() => {
        throw new Error("fail");
      });

      const branches = listBranches("/tmp/repo");

      expect(branches).toEqual([]);
    });

    it("фильтрует пустые строки", () => {
      mockGit.mockReturnValue("  origin/main\n\n  origin/dev\n");

      const branches = listBranches("/tmp/repo");

      expect(branches).toEqual(["main", "dev"]);
    });
  });

  describe("getDefaultBranch", () => {
    it("возвращает имя текущей ветки", () => {
      mockGit.mockReturnValue("main\n");

      const branch = getDefaultBranch("/tmp/repo");

      expect(branch).toBe("main");
    });

    it("возвращает null при ошибке", () => {
      mockGit.mockImplementation(() => {
        throw new Error("fail");
      });

      const branch = getDefaultBranch("/tmp/repo");

      expect(branch).toBeNull();
    });

    it("возвращает null при пустом выводе", () => {
      mockGit.mockReturnValue("  \n");

      const branch = getDefaultBranch("/tmp/repo");

      expect(branch).toBeNull();
    });
  });

  describe("checkRepoAccess", () => {
    it("возвращает ok:true при успешной проверке", () => {
      mockGit.mockReturnValue("abc123def456\tHEAD\n");

      const result = checkRepoAccess("git@github.com:user/repo.git");

      expect(result).toEqual({ ok: true });
      expect(mockGit).toHaveBeenCalledWith(
        expect.any(String),
        ["ls-remote", "git@github.com:user/repo.git", "HEAD"],
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it("распознаёт SSH Permission denied", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "Permission denied (publickey).",
        });
      });

      const result = checkRepoAccess("git@github.com:user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Нет SSH-доступа к репозиторию");
        expect(result.hint).toContain("ssh -T git@github.com");
        expect(result.hint).toContain("ssh-keygen");
      }
    });

    it("распознаёт Repository not found", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "ERROR: Repository not found.",
        });
      });

      const result = checkRepoAccess("git@github.com:user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Репозиторий не найден");
        expect(result.hint).toContain("Опечатка в URL");
      }
    });

    it("распознаёт could not read Username", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "fatal: could not read Username for 'https://github.com'",
        });
      });

      const result = checkRepoAccess("https://github.com/user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Ошибка аутентификации");
        expect(result.hint).toContain("personal access token");
      }
    });

    it("распознаёт Authentication failed", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "fatal: Authentication failed",
        });
      });

      const result = checkRepoAccess("https://github.com/user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Ошибка аутентификации");
        expect(result.hint).toContain("SSH");
      }
    });

    it("распознаёт Connection timed out", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "fatal: Connection timed out",
        });
      });

      const result = checkRepoAccess("git@github.com:user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Не удалось подключиться к серверу");
        expect(result.hint).toContain("Интернет");
      }
    });

    it("распознаёт Could not resolve", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "fatal: Could not resolve hostname github.com",
        });
      });

      const result = checkRepoAccess("git@github.com:user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Не удалось подключиться к серверу");
      }
    });

    it("возвращает fallback для неизвестной ошибки", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "fatal: some unknown error",
        });
      });

      const result = checkRepoAccess("git@github.com:user/repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.hint).toContain("URL");
      }
    });

    it("маскирует URL в fallback-ошибке", () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "git@github.com:user/secret-repo.git fatal error",
        });
      });

      const result = checkRepoAccess("git@github.com:user/secret-repo.git");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("secret-repo");
      }
    });
  });

  describe("preflightCheck", () => {
    const config = {
      repo: "git@github.com:user/repo.git",
      deviceName: "test",
      localPath: "/tmp/repo",
      branch: "main",
    };

    beforeEach(() => {
      mockCheckInternet.mockResolvedValue(true);
      mockGit.mockReturnValue("abc123\tHEAD\n");
    });

    it("проходит успешно если интернет и доступ есть", async () => {
      await expect(preflightCheck(config)).resolves.toBeUndefined();
      expect(mockCheckInternet).toHaveBeenCalled();
      expect(mockGit).toHaveBeenCalledWith(expect.any(String), ["ls-remote", config.repo, "HEAD"], expect.any(Object));
    });

    it("бросает PreflightError если нет интернета", async () => {
      mockCheckInternet.mockResolvedValue(false);

      try {
        await preflightCheck(config);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PreflightError);
        expect((err as PreflightError).message).toBe("Нет подключения к интернету");
        expect((err as PreflightError).hint).toContain("WiFi");
      }
    });

    it("не проверяет доступ к репо если нет интернета", async () => {
      mockCheckInternet.mockResolvedValue(false);

      try {
        await preflightCheck(config);
      } catch {}

      expect(mockGit).not.toHaveBeenCalled();
    });

    it("бросает PreflightError если нет доступа к репозиторию", async () => {
      mockGit.mockImplementation(() => {
        throw Object.assign(new Error("fatal"), {
          stderr: "Permission denied (publickey).",
        });
      });

      try {
        await preflightCheck(config);
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PreflightError);
        expect((err as PreflightError).message).toBe("Нет SSH-доступа к репозиторию");
        expect((err as PreflightError).hint).toContain("ssh -T");
      }
    });

    it("PreflightError содержит hint", () => {
      const err = new PreflightError("test error", "test hint");
      expect(err.name).toBe("PreflightError");
      expect(err.message).toBe("test error");
      expect(err.hint).toBe("test hint");
    });
  });
});
