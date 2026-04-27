import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => '{"version": "1.0.0"}'),
}));

vi.mock("node:path", () => ({
  join: vi.fn((...args) => args.join("/")),
  dirname: vi.fn(() => "/app/dist"),
}));

vi.mock("node:url", () => ({
  fileURLToPath: vi.fn(() => "/app/dist/banner.ts"),
}));

vi.mock("figlet", () => ({
  default: {
    parseFont: vi.fn(),
    textSync: vi.fn(() => "MOCK_ASCII_ART"),
  },
}));

vi.mock("figlet/importable-fonts/Big.js", () => ({
  default: "MOCK_FONT_DATA",
}));

import { printBanner, getBanner } from "./banner.js";
import figlet from "figlet";

describe("banner.ts", () => {
  it("вызывает figlet.textSync с шрифтом Big", () => {
    getBanner();
    expect(figlet.textSync).toHaveBeenCalledWith("OpenCode Sync", { font: "Big" });
  });

  it("вызывает figlet.parseFont для регистрации шрифта", () => {
    getBanner();
    expect(figlet.parseFont).toHaveBeenCalledWith("Big", "MOCK_FONT_DATA");
  });

  it("getBanner содержит ASCII-арт из figlet", () => {
    const banner = getBanner();
    expect(banner).toContain("MOCK_ASCII_ART");
  });

  it("getBanner содержит версию", () => {
    const banner = getBanner();
    expect(banner).toContain("v1.0.0");
  });

  it("getBanner содержит описание", () => {
    const banner = getBanner();
    expect(banner).toContain("Синхронизация сессий OpenCode между вашими устройствами");
  });

  it("getBanner содержит подпись Chumikov Sec", () => {
    const banner = getBanner();
    expect(banner).toContain("Chumikov Sec");
    expect(banner).toContain("https://t.me/chumikovsec");
  });

  it("printBanner выводит баннер в stdout", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    printBanner();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("v1.0.0"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("OpenCode"));

    logSpy.mockRestore();
  });
});
