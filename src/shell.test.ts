import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { installShellFunction, getShellInfo, isShellFunctionInstalled } from "./shell.js";

describe("shell.ts", () => {
  let originalShell: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalShell = process.env.SHELL;
  });

  afterEach(() => {
    process.env.SHELL = originalShell;
  });

  function afterEach() {}

  describe("getShellInfo", () => {
    it("определяет zsh", () => {
      process.env.SHELL = "/bin/zsh";
      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("zsh");
      expect(info!.rcFile).toContain(".zshrc");
    });

    it("определяет bash с .bashrc", () => {
      process.env.SHELL = "/bin/bash";
      vi.mocked(existsSync).mockReturnValue(true);
      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("bash");
      expect(info!.rcFile).toContain(".bashrc");
    });

    it("определяет bash с .bash_profile", () => {
      process.env.SHELL = "/bin/bash";
      vi.mocked(existsSync)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("bash");
      expect(info!.rcFile).toContain(".bash_profile");
    });

    it("fallback на .bashrc если оба файла отсутствуют", () => {
      process.env.SHELL = "/bin/bash";
      vi.mocked(existsSync).mockReturnValue(false);
      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("bash");
      expect(info!.rcFile).toContain(".bashrc");
    });

    it("возвращает null для fish", () => {
      process.env.SHELL = "/bin/fish";
      const info = getShellInfo();
      expect(info).toBeNull();
    });

    it("возвращает null для пустого SHELL", () => {
      delete process.env.SHELL;
      const info = getShellInfo();
      expect(info).toBeNull();
    });
  });

  describe("isShellFunctionInstalled", () => {
    it("возвращает false если файл не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(isShellFunctionInstalled("/home/test/.zshrc")).toBe(false);
    });

    it("возвращает true если блок найден", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        "some content\n# >>> opencode-sync >>>\nopencode() {}\n# <<< opencode-sync <<<\n",
      );

      expect(isShellFunctionInstalled("/home/test/.zshrc")).toBe(true);
    });

    it("возвращает false если блока нет", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("some content\n");

      expect(isShellFunctionInstalled("/home/test/.zshrc")).toBe(false);
    });
  });

  describe("installShellFunction", () => {
    it("возвращает installed=false для fish", () => {
      process.env.SHELL = "/bin/fish";
      const result = installShellFunction();
      expect(result.installed).toBe(false);
    });

    it("не перезаписывает если блок уже установлен", () => {
      process.env.SHELL = "/bin/zsh";

      vi.mocked(existsSync)
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      vi.mocked(readFileSync).mockReturnValue(
        "# >>> opencode-sync >>>\nopencode() {}\n# <<< opencode-sync <<<\n",
      );

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("добавляет блок если его нет", () => {
      process.env.SHELL = "/bin/zsh";

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("existing content\n");

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(result.shellName).toBe("zsh");
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".zshrc"),
        expect.stringContaining(">>> opencode-sync >>>"),
        "utf-8",
      );
    });

    it("создаёт файл если его нет", () => {
      process.env.SHELL = "/bin/zsh";

      vi.mocked(existsSync).mockReturnValue(false);

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("opencode()"),
        "utf-8",
      );
    });

    it("добавляет функцию opencode() с command opencode", () => {
      process.env.SHELL = "/bin/zsh";

      vi.mocked(existsSync).mockReturnValue(false);

      installShellFunction();

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain("command opencode \"$@\"");
      expect(written).toContain("command opencode-sync pull");
      expect(written).toContain("command opencode-sync push");
    });
  });
});
