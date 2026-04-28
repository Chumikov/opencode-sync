import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { installShellFunction, getShellInfo, isShellFunctionInstalled } from "./shell.js";

describe("shell.ts", () => {
  let originalShell: string | undefined;
  let originalPsModulePath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalShell = process.env.SHELL;
    originalPsModulePath = process.env.PSModulePath;
  });

  afterEach(() => {
    process.env.SHELL = originalShell;
    if (originalPsModulePath !== undefined) {
      process.env.PSModulePath = originalPsModulePath;
    } else {
      delete process.env.PSModulePath;
    }
  });

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

    it("определяет fish", () => {
      process.env.SHELL = "/bin/fish";
      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("fish");
      expect(info!.rcFile).toContain("fish");
      expect(info!.rcFile).toContain("opencode.fish");
    });

    it("определяет PowerShell по существующему профилю pwsh", () => {
      process.env.SHELL = "";
      delete process.env.PSModulePath;
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes("PowerShell") && !String(p).includes("Windows"),
      );

      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("powershell");
      expect(info!.rcFile).toContain("PowerShell");
      expect(info!.rcFile).toContain("Microsoft.PowerShell_profile.ps1");
    });

    it("определяет PowerShell по PSModulePath", () => {
      process.env.SHELL = "";
      process.env.PSModulePath = "/some/path";
      vi.mocked(existsSync).mockReturnValue(false);

      const info = getShellInfo();
      expect(info).not.toBeNull();
      expect(info!.shellName).toBe("powershell");
    });

    it("возвращает null для неизвестного shell без PowerShell", () => {
      process.env.SHELL = "/bin/csh";
      delete process.env.PSModulePath;
      vi.mocked(existsSync).mockReturnValue(false);
      const info = getShellInfo();
      expect(info).toBeNull();
    });

    it("возвращает null для пустого SHELL без PowerShell", () => {
      delete process.env.SHELL;
      delete process.env.PSModulePath;
      vi.mocked(existsSync).mockReturnValue(false);
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

  describe("installShellFunction — bash/zsh", () => {
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

  describe("installShellFunction — fish", () => {
    it("устанавливает fish-функцию", () => {
      process.env.SHELL = "/bin/fish";
      vi.mocked(existsSync).mockReturnValue(false);

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(result.shellName).toBe("fish");
      expect(result.rcFile).toContain("opencode.fish");
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("functions"),
        { recursive: true },
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("opencode.fish"),
        expect.stringContaining("function opencode"),
        "utf-8",
      );
    });

    it("содержит fish-синтаксис: $argv, set -l, $status, end", () => {
      process.env.SHELL = "/bin/fish";
      vi.mocked(existsSync).mockReturnValue(false);

      installShellFunction();

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain("command opencode $argv");
      expect(written).toContain("set -l exit_code $status");
      expect(written).toContain("end");
    });

    it("не перезаписывает если fish-функция уже установлена", () => {
      process.env.SHELL = "/bin/fish";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("function opencode\nend\n");

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("installShellFunction — PowerShell", () => {
    it("устанавливает PowerShell-функцию", () => {
      process.env.SHELL = "";
      process.env.PSModulePath = "/some/path";
      vi.mocked(existsSync).mockReturnValue(false);

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(result.shellName).toBe("powershell");
      expect(result.rcFile).toContain("Microsoft.PowerShell_profile.ps1");
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining("Microsoft.PowerShell_profile.ps1"),
        expect.stringContaining("function opencode"),
        "utf-8",
      );
    });

    it("содержит PS-синтаксис: @args, $LASTEXITCODE, 2>$null", () => {
      process.env.SHELL = "";
      process.env.PSModulePath = "/some/path";
      vi.mocked(existsSync).mockReturnValue(false);

      installShellFunction();

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain("opencode.exe @args");
      expect(written).toContain("$LASTEXITCODE");
      expect(written).toContain("2>$null");
    });

    it("не перезаписывает если блок уже установлен", () => {
      process.env.SHELL = "";
      process.env.PSModulePath = "/some/path";
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        "# >>> opencode-sync >>>\nfunction opencode {}\n# <<< opencode-sync <<<\n",
      );

      const result = installShellFunction();

      expect(result.installed).toBe(true);
      expect(writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("installShellFunction — неподдерживаемый shell", () => {
    it("возвращает installed=false для неизвестного shell", () => {
      process.env.SHELL = "/bin/csh";
      delete process.env.PSModulePath;
      vi.mocked(existsSync).mockReturnValue(false);

      const result = installShellFunction();

      expect(result.installed).toBe(false);
      expect(result.rcFile).toBe("");
      expect(result.shellName).toBe("");
    });
  });
});
