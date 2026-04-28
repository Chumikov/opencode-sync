import { lookup } from "node:dns/promises";

const DNS_HOST = "dns.google";
const DNS_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function checkInternet(): Promise<boolean> {
  try {
    await withTimeout(lookup(DNS_HOST), DNS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}
