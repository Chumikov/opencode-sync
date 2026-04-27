import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import figlet from "figlet";
import figletBig from "figlet/importable-fonts/Big.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export const VERSION: string = pkg.version;

figlet.parseFont("Big", figletBig);

function buildBanner(): string {
  const ascii = figlet.textSync("OpenCode Sync", { font: "Big" });
  return `${ascii}\n  v${pkg.version}\n\n  Синхронизация сессий OpenCode между вашими устройствами\n  Chumikov Sec — https://t.me/chumikovsec`;
}

const LOGO = buildBanner();

export function printBanner(): void {
  console.log(LOGO);
}

export function getBanner(): string {
  return LOGO;
}
