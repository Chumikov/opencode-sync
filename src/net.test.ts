import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { checkInternet } from "./net.js";
import { lookup } from "node:dns/promises";

const mockLookup = vi.mocked(lookup);

describe("net.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("возвращает true если DNS resolve успешен", async () => {
    mockLookup.mockResolvedValue({ address: "8.8.8.8", family: 4 });

    expect(await checkInternet()).toBe(true);
    expect(mockLookup).toHaveBeenCalledWith("dns.google");
  });

  it("возвращает false если DNS resolve падает", async () => {
    mockLookup.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    expect(await checkInternet()).toBe(false);
  });

  it("возвращает false при DNS timeout", async () => {
    mockLookup.mockRejectedValue(new Error("getaddrinfo ETIMEOUT"));

    expect(await checkInternet()).toBe(false);
  });
});
