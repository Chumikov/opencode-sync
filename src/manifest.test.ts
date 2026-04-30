import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addToDeletedSet,
  deviceManifestExists,
  findOrphanFiles,
  getGlobalSessionSet,
  manifestsDir,
  readDeletedSet,
  readManifest,
  writeDeletedSet,
  writeManifest,
} from "./manifest.js";

describe("manifest.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("manifestsDir", () => {
    it("возвращает путь manifests внутри localPath", () => {
      expect(manifestsDir("/tmp/sync")).toBe(join("/tmp/sync", "manifests"));
    });
  });

  describe("readManifest", () => {
    it("возвращает пустой Set если файл не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = readManifest("/tmp/sync", "macbook");
      expect(result.size).toBe(0);
    });

    it("читает sessionIds из JSON", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ sessionIds: ["s1", "s2", "s3"] }));

      const result = readManifest("/tmp/sync", "macbook");

      expect(result).toEqual(new Set(["s1", "s2", "s3"]));
    });

    it("возвращает пустой Set при битом JSON", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("NOT JSON");

      const result = readManifest("/tmp/sync", "macbook");
      expect(result.size).toBe(0);
    });
  });

  describe("writeManifest", () => {
    it("создаёт директорию и записывает JSON", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      writeManifest("/tmp/sync", "macbook", new Set(["s1", "s2"]));

      expect(mkdirSync).toHaveBeenCalledWith(join("/tmp/sync", "manifests"), { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        join("/tmp/sync", "manifests", "macbook.json"),
        expect.any(String),
        "utf-8",
      );

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.sessionIds).toEqual(["s1", "s2"]);
    });

    it("не создаёт директорию если она существует", () => {
      vi.mocked(existsSync).mockReturnValue(true);

      writeManifest("/tmp/sync", "macbook", new Set());

      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe("getGlobalSessionSet", () => {
    it("объединяет sessionIds из всех манифестов", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(["macbook.json", "thinkpad.json"] as any);
      vi.mocked(readFileSync)
        .mockReturnValueOnce(JSON.stringify({ sessionIds: ["s1", "s2"] }))
        .mockReturnValueOnce(JSON.stringify({ sessionIds: ["s2", "s3"] }));

      const result = getGlobalSessionSet("/tmp/sync");

      expect(result).toEqual(new Set(["s1", "s2", "s3"]));
    });

    it("возвращает пустой Set если директория не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = getGlobalSessionSet("/tmp/sync");

      expect(result.size).toBe(0);
    });

    it("пропускает битые манифесты", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(["bad.json"] as any);
      vi.mocked(readFileSync).mockReturnValue("NOT JSON");

      const result = getGlobalSessionSet("/tmp/sync");

      expect(result.size).toBe(0);
    });
  });

  describe("readDeletedSet", () => {
    it("возвращает пустой Set если файл не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = readDeletedSet("/tmp/sync", "macbook");

      expect(result.size).toBe(0);
    });

    it("читает sessionIds из JSON", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ sessionIds: ["s1", "s2"] }));

      const result = readDeletedSet("/tmp/sync", "macbook");

      expect(result).toEqual(new Set(["s1", "s2"]));
    });

    it("возвращает пустой Set при битом JSON", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("NOT JSON");

      const result = readDeletedSet("/tmp/sync", "macbook");

      expect(result.size).toBe(0);
    });
  });

  describe("writeDeletedSet", () => {
    it("создаёт директорию и записывает JSON", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      writeDeletedSet("/tmp/sync", "macbook", new Set(["s1", "s2"]));

      expect(mkdirSync).toHaveBeenCalledWith(join("/tmp/sync", "manifests"), { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        join("/tmp/sync", "manifests", "macbook-deleted.json"),
        expect.any(String),
        "utf-8",
      );

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.sessionIds).toEqual(["s1", "s2"]);
    });
  });

  describe("addToDeletedSet", () => {
    it("добавляет новые id к существующему множеству", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ sessionIds: ["s1"] }));

      addToDeletedSet("/tmp/sync", "macbook", ["s2", "s3"]);

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.sessionIds).toEqual(["s1", "s2", "s3"]);
    });

    it("создаёт новый файл если не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      addToDeletedSet("/tmp/sync", "macbook", ["s1"]);

      const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.sessionIds).toEqual(["s1"]);
    });
  });

  describe("deviceManifestExists", () => {
    it("возвращает true если манифест существует", () => {
      vi.mocked(existsSync).mockReturnValue(true);

      expect(deviceManifestExists("/tmp/sync", "macbook")).toBe(true);
    });

    it("возвращает false если манифест не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(deviceManifestExists("/tmp/sync", "macbook")).toBe(false);
    });
  });

  describe("findOrphanFiles", () => {
    it("возвращает пустой массив если sessionsDir не существует", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const orphans = findOrphanFiles("/tmp/sync/sessions", new Set(["s1"]));

      expect(orphans).toEqual([]);
    });

    it("находит JSON-файлы без живых манифестов", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        { name: "s1.json", isFile: () => true, isDirectory: () => false },
        { name: "s2.json", isFile: () => true, isDirectory: () => false },
        { name: "s3.json", isFile: () => true, isDirectory: () => false },
      ] as any);

      const orphans = findOrphanFiles("/tmp/sessions", new Set(["s1", "s2"]));

      expect(orphans).toEqual([join("/tmp/sessions", "s3.json")]);
    });

    it("не считает живые сессии orphan", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue([
        { name: "s1.json", isFile: () => true, isDirectory: () => false },
      ] as any);

      const orphans = findOrphanFiles("/tmp/sessions", new Set(["s1"]));

      expect(orphans).toEqual([]);
    });
  });
});
