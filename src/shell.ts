import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SHELL_FUNCTION_BLOCK_START = "# >>> opencode-sync >>>";
const SHELL_FUNCTION_BLOCK_END = "# <<< opencode-sync <<<";

const SHELL_FUNCTION = `opencode() {
  command opencode-sync pull 2>/dev/null
  command opencode "$@"
  local exit_code=$?
  command opencode-sync push 2>/dev/null
  return $exit_code
}`;

function getShellInfo(): { rcFile: string; shellName: string } | null {
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

  return null;
}

function isShellFunctionInstalled(rcFile: string): boolean {
  if (!existsSync(rcFile)) return false;
  const content = readFileSync(rcFile, "utf-8");
  return content.includes(SHELL_FUNCTION_BLOCK_START);
}

export function installShellFunction(): { installed: boolean; rcFile: string; shellName: string } {
  const info = getShellInfo();

  if (!info) {
    return { installed: false, rcFile: "", shellName: "" };
  }

  const { rcFile, shellName } = info;

  if (isShellFunctionInstalled(rcFile)) {
    return { installed: true, rcFile, shellName };
  }

  const block = `${SHELL_FUNCTION_BLOCK_START}
${SHELL_FUNCTION}
${SHELL_FUNCTION_BLOCK_END}`;

  let existingContent = "";
  if (existsSync(rcFile)) {
    existingContent = readFileSync(rcFile, "utf-8");
  }

  const newContent = existingContent
    ? existingContent.endsWith("\n")
      ? existingContent + "\n" + block + "\n"
      : existingContent + "\n\n" + block + "\n"
    : block + "\n";

  writeFileSync(rcFile, newContent, "utf-8");

  return { installed: true, rcFile, shellName };
}

export { getShellInfo, isShellFunctionInstalled };
