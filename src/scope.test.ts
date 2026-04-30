import { describe, expect, it, vi } from "vitest";
import { _getFirstCommit, _getGitRoot, detectProjectScope, scopeProjectId } from "./scope.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("./util.js", () => ({
  log: vi.fn(),
}));

import { execFileSync } from "node:child_process";

const mockExec = vi.mocked(execFileSync);

describe("scope.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("detectProjectScope", () => {
    it("возвращает global если нет git-репозитория", () => {
      mockExec.mockImplementation((...args: any[]) => {
        const gitArgs = args[1] as string[];
        if (gitArgs[0] === "rev-parse") throw new Error("not a git repo");
        return "";
      });

      const scope = detectProjectScope("/tmp/not-git");

      expect(scope).toEqual({ type: "global" });
    });

    it("возвращает global если пустой git-репозиторий (нет коммитов)", () => {
      mockExec.mockImplementation((...args: any[]) => {
        const gitArgs = args[1] as string[];
        if (gitArgs[0] === "rev-parse") return "/home/user/project\n";
        if (gitArgs[0] === "rev-list") throw new Error("no commits");
        return "";
      });

      const scope = detectProjectScope("/home/user/project");

      expect(scope).toEqual({ type: "global" });
    });

    it("возвращает project с projectId = SHA первого коммита", () => {
      mockExec.mockImplementation((...args: any[]) => {
        const gitArgs = args[1] as string[];
        if (gitArgs[0] === "rev-parse") return "/home/user/project\n";
        if (gitArgs[0] === "rev-list") return "e89b5fab1fe1a145014f360480cdd65e6c6e4b52\n";
        return "";
      });

      const scope = detectProjectScope("/home/user/project");

      expect(scope).toEqual({
        type: "project",
        projectId: "e89b5fab1fe1a145014f360480cdd65e6c6e4b52",
      });
    });

    it("использует process.cwd() если cwd не указан", () => {
      mockExec.mockImplementation((...args: any[]) => {
        const opts = args[2] as { cwd?: string };
        if (opts?.cwd === process.cwd()) return "/some/path\n";
        return "abc123\n";
      });

      const scope = detectProjectScope();

      expect(scope.type).toBe("project");
    });

    it("передаёт cwd в git-команды", () => {
      mockExec.mockImplementation((...args: any[]) => {
        const opts = args[2] as { cwd?: string };
        if (opts?.cwd === "/custom/path") return "/custom/path\n";
        return "deadbeef\n";
      });

      const scope = detectProjectScope("/custom/path");

      expect(scope.type).toBe("project");
      expect(mockExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["rev-parse", "--show-toplevel"]),
        expect.objectContaining({ cwd: "/custom/path" }),
      );
    });
  });

  describe("scopeProjectId", () => {
    it("возвращает projectId для project scope", () => {
      expect(scopeProjectId({ type: "project", projectId: "abc123" })).toBe("abc123");
    });

    it("возвращает 'global' для global scope", () => {
      expect(scopeProjectId({ type: "global" })).toBe("global");
    });
  });

  describe("_getGitRoot", () => {
    it("возвращает путь к git root", () => {
      mockExec.mockReturnValue("/home/user/project\n");
      expect(_getGitRoot("/home/user/project/src")).toBe("/home/user/project");
    });

    it("возвращает null при ошибке", () => {
      mockExec.mockImplementation(() => {
        throw new Error("not a git repo");
      });
      expect(_getGitRoot("/tmp")).toBeNull();
    });
  });

  describe("_getFirstCommit", () => {
    it("возвращает SHA первого коммита", () => {
      mockExec.mockReturnValue("e89b5fab1fe1a145014f360480cdd65e6c6e4b52\n");
      expect(_getFirstCommit("/home/user/project")).toBe("e89b5fab1fe1a145014f360480cdd65e6c6e4b52");
    });

    it("возвращает null при ошибке", () => {
      mockExec.mockImplementation(() => {
        throw new Error("no commits");
      });
      expect(_getFirstCommit("/tmp/repo")).toBeNull();
    });
  });
});
