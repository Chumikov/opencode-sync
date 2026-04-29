import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SYNC_LOG_PATH } from "./config.js";

const SHELL_FUNCTION_BLOCK_START = "# >>> opencode-sync >>>";
const SHELL_FUNCTION_BLOCK_END = "# <<< opencode-sync <<<";

const SYNC_LOG_POSIX = SYNC_LOG_PATH.replace(/\\/g, "/");

const BASH_FUNCTION = `opencode() {
  local _sync_log="${SYNC_LOG_POSIX}"
  mkdir -p "$(dirname "$_sync_log")" 2>/dev/null
  command opencode-sync pull 2>>"$_sync_log" || echo "opencode-sync: ошибка pull (подробности: $_sync_log)" >&2
  command opencode "$@"
  local exit_code=$?
  command opencode-sync push 2>>"$_sync_log" || echo "opencode-sync: ошибка push (подробности: $_sync_log)" >&2
  return $exit_code
}`;

const FISH_FUNCTION = `function opencode
    set -l _sync_log "${SYNC_LOG_POSIX}"
    mkdir -p (dirname "$_sync_log") 2>/dev/null
    command opencode-sync pull 2>>"$_sync_log"; or echo "opencode-sync: ошибка pull (подробности: $_sync_log)" >&2
    command opencode $argv
    set -l exit_code $status
    command opencode-sync push 2>>"$_sync_log"; or echo "opencode-sync: ошибка push (подробности: $_sync_log)" >&2
    return $exit_code
end`;

const PS_FUNCTION = `function opencode {
    $syncLog = "${SYNC_LOG_PATH.replace(/\\/g, "/")}"
    New-Item -ItemType Directory -Force (Split-Path $syncLog) | Out-Null
    opencode-sync pull 2>>$syncLog
    if ($LASTEXITCODE -ne 0) { Write-Error "opencode-sync: ошибка pull (подробности: $syncLog)" }
    opencode.exe @args
    $exit_code = $LASTEXITCODE
    opencode-sync push 2>>$syncLog
    if ($LASTEXITCODE -ne 0) { Write-Error "opencode-sync: ошибка push (подробности: $syncLog)" }
    return $exit_code
}`;

export type ShellType = "bash" | "zsh" | "fish" | "powershell";

export interface ShellInfo {
  rcFile: string;
  shellName: ShellType;
}

function detectPosixShell(): ShellInfo | null {
  const shell = process.env.SHELL || "";
  const home = homedir();

  if (shell.endsWith("/zsh")) {
    return { rcFile: join(home, ".zshrc"), shellName: "zsh" };
  }

  if (shell.endsWith("/bash")) {
    const bashRc = join(home, ".bashrc");
    const bashProfile = join(home, ".bash_profile");

    if (existsSync(bashRc)) {
      return { rcFile: bashRc, shellName: "bash" };
    }
    if (existsSync(bashProfile)) {
      return { rcFile: bashProfile, shellName: "bash" };
    }
    return { rcFile: bashRc, shellName: "bash" };
  }

  if (shell.endsWith("/fish")) {
    const fishFuncDir = join(home, ".config", "fish", "functions");
    return { rcFile: join(fishFuncDir, "opencode.fish"), shellName: "fish" };
  }

  return null;
}

function detectPowerShell(): ShellInfo | null {
  const home = homedir();

  const pwshProfile = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  const winPsProfile = join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");

  if (existsSync(pwshProfile)) {
    return { rcFile: pwshProfile, shellName: "powershell" };
  }

  if (existsSync(winPsProfile)) {
    return { rcFile: winPsProfile, shellName: "powershell" };
  }

  if (process.env.PSModulePath !== undefined) {
    return { rcFile: pwshProfile, shellName: "powershell" };
  }

  return null;
}

export function getShellInfo(): ShellInfo | null {
  const posix = detectPosixShell();
  if (posix) return posix;

  const pwsh = detectPowerShell();
  if (pwsh) return pwsh;

  return null;
}

function isBlockInstalled(rcFile: string): boolean {
  if (!existsSync(rcFile)) return false;
  const content = readFileSync(rcFile, "utf-8");
  return content.includes(SHELL_FUNCTION_BLOCK_START);
}

function isFishFunctionInstalled(rcFile: string): boolean {
  if (!existsSync(rcFile)) return false;
  const content = readFileSync(rcFile, "utf-8");
  return content.includes("function opencode");
}

function installBlockToRcFile(rcFile: string, block: string): void {
  if (isBlockInstalled(rcFile)) return;

  let existingContent = "";
  if (existsSync(rcFile)) {
    existingContent = readFileSync(rcFile, "utf-8");
  }

  const newContent = existingContent
    ? existingContent.endsWith("\n")
      ? `${existingContent}\n${block}\n`
      : `${existingContent}\n\n${block}\n`
    : `${block}\n`;

  mkdirSync(dirname(rcFile), { recursive: true });
  writeFileSync(rcFile, newContent, "utf-8");
}

function installFishFunction(rcFile: string): void {
  if (isFishFunctionInstalled(rcFile)) return;

  mkdirSync(dirname(rcFile), { recursive: true });
  writeFileSync(rcFile, `${FISH_FUNCTION}\n`, "utf-8");
}

export function installShellFunction(): { installed: boolean; rcFile: string; shellName: string } {
  const info = getShellInfo();

  if (!info) {
    return { installed: false, rcFile: "", shellName: "" };
  }

  const { rcFile, shellName } = info;

  switch (shellName) {
    case "fish":
      installFishFunction(rcFile);
      break;
    case "powershell": {
      const block = `${SHELL_FUNCTION_BLOCK_START}
${PS_FUNCTION}
${SHELL_FUNCTION_BLOCK_END}`;
      installBlockToRcFile(rcFile, block);
      break;
    }
    default: {
      const block = `${SHELL_FUNCTION_BLOCK_START}
${BASH_FUNCTION}
${SHELL_FUNCTION_BLOCK_END}`;
      installBlockToRcFile(rcFile, block);
      break;
    }
  }

  return { installed: true, rcFile, shellName: String(shellName) };
}

export { isBlockInstalled as isShellFunctionInstalled };
