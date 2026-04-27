import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateSessionId,
  log,
  promisePool,
  acquireLock,
  releaseLock,
  withLock,
  withLockAsync,
  withRetry,
  SESSION_ID_RE,
  EXPORT_CONCURRENCY,
  RETRY_ATTEMPTS,
} from "./util.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("util.ts", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });
  describe("constants", () => {
    it("SESSION_ID_RE принимает буквенно-цифровые ID", () => {
      expect(SESSION_ID_RE.test("abc123")).toBe(true);
      expect(SESSION_ID_RE.test("01JTEST00000000000000000001")).toBe(true);
    });

    it("SESSION_ID_RE отклоняет спецсимволы", () => {
      expect(SESSION_ID_RE.test("abc-123")).toBe(false);
      expect(SESSION_ID_RE.test("abc 123")).toBe(false);
      expect(SESSION_ID_RE.test("")).toBe(false);
      expect(SESSION_ID_RE.test("--flag")).toBe(false);
    });

    it("EXPORT_CONCURRENCY >= 1", () => {
      expect(EXPORT_CONCURRENCY).toBeGreaterThanOrEqual(1);
    });

    it("RETRY_ATTEMPTS >= 1", () => {
      expect(RETRY_ATTEMPTS).toBeGreaterThanOrEqual(1);
    });
  });

  describe("validateSessionId", () => {
    it("пропускает валидный ID", () => {
      expect(() => validateSessionId("abc123")).not.toThrow();
    });

    it("бросает ошибку для невалидного ID", () => {
      expect(() => validateSessionId("abc-123")).toThrow("Invalid session ID");
    });

    it("бросает ошибку для пустого ID", () => {
      expect(() => validateSessionId("")).toThrow("Invalid session ID");
    });
  });

  describe("log", () => {
    it("пишет в stderr", () => {
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      log("test message");
      expect(spy).toHaveBeenCalledWith("test message\n");
      spy.mockRestore();
    });
  });

  describe("promisePool", () => {
    it("выполняет все элементы", async () => {
      const items = [1, 2, 3];
      const results = await promisePool(items, 2, async (n) => n * 2);
      expect(results.sort()).toEqual([2, 4, 6]);
    });

    it("ограничивает параллелизм", async () => {
      let running = 0;
      let maxRunning = 0;

      await promisePool(
        Array.from({ length: 10 }, (_, i) => i),
        3,
        async (n) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 10));
          running--;
          return n;
        },
      );

      expect(maxRunning).toBeLessThanOrEqual(3);
    });

    it("возвращает пустой массив для пустого входа", async () => {
      const results = await promisePool([], 5, async (n: number) => n);
      expect(results).toEqual([]);
    });

    it("пробрасывает ошибки", async () => {
      await expect(
        promisePool([1], 1, async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    });
  });

  describe("lock", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("создаёт lock-файл", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      acquireLock("/tmp/test");
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".opencode-sync.lock"),
        String(process.pid),
        "utf-8",
      );
    });

    it("удаляет lock-файл при release", () => {
      releaseLock("/tmp/test");
      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining(".opencode-sync.lock"),
      );
    });

    it("бросает ошибку если процесс уже запущен", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(String(process.pid));

      expect(() => acquireLock("/tmp/test")).toThrow("уже запущен");
    });

    it("удаляет stale lock если процесс не существует", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("999999999");
      vi.mocked(unlinkSync).mockReturnValue(undefined);

      expect(() => acquireLock("/tmp/test")).not.toThrow();
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("удаляет lock при невалидном PID", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("not-a-number");

      expect(() => acquireLock("/tmp/test")).not.toThrow();
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("withLock вызывает fn и освобождает lock", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const fn = vi.fn(() => 42);

      const result = withLock("/tmp/test", fn);

      expect(result).toBe(42);
      expect(fn).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalled();
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("withLock освобождает lock даже при ошибке", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const fn = vi.fn(() => {
        throw new Error("boom");
      });

      expect(() => withLock("/tmp/test", fn)).toThrow("boom");
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("withLockAsync вызывает async fn и освобождает lock", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const fn = vi.fn(async () => 42);

      const result = await withLockAsync("/tmp/test", fn);

      expect(result).toBe(42);
      expect(fn).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalled();
      expect(unlinkSync).toHaveBeenCalled();
    });

    it("withLockAsync освобождает lock даже при async-ошибке", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const fn = vi.fn(async () => {
        throw new Error("async boom");
      });

      await expect(withLockAsync("/tmp/test", fn)).rejects.toThrow("async boom");
      expect(unlinkSync).toHaveBeenCalled();
    });
  });

  describe("withRetry", () => {
    it("возвращает результат при успехе", async () => {
      const result = await withRetry(() => 42, 3);
      expect(result).toBe(42);
    });

    it("повторяет при неудаче", async () => {
      let attempts = 0;
      const result = await withRetry(() => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return "ok";
      }, 3, 1);

      expect(result).toBe("ok");
      expect(attempts).toBe(3);
    });

    it("бросает последнюю ошибку после всех попыток", async () => {
      await expect(
        withRetry(() => {
          throw new Error("always fail");
        }, 2, 1),
      ).rejects.toThrow("always fail");
    });

    it("работает с async функциями", async () => {
      const result = await withRetry(async () => "async ok", 3);
      expect(result).toBe("async ok");
    });
  });
});
