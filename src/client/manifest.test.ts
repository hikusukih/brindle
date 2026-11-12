import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./service-worker";

const publicDir = new URL("./public/", import.meta.url);

describe("PWA manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", publicDir), "utf8"));

  it("is installable: standalone, with a start URL and 192 and 512 icons that exist", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    for (const icon of manifest.icons) {
      expect(existsSync(new URL(icon.src.replace(/^\//, ""), publicDir))).toBe(true);
    }
  });

  it("is linked from the page", () => {
    const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
    expect(html).toContain('rel="manifest"');
  });
});

describe("the service worker", () => {
  it("is served from the root, so its scope covers the whole app, and caches nothing", () => {
    const source = readFileSync(new URL("sw.js", publicDir), "utf8");
    expect(source).not.toMatch(/caches\.|addEventListener\("fetch"/);
  });

  it("registers at the root scope", async () => {
    const register = vi.fn(async () => ({}));
    expect(await registerServiceWorker({ serviceWorker: { register } } as unknown as Navigator)).toBe(true);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("is skipped quietly where the browser has none or refuses, as over plain HTTP", async () => {
    expect(await registerServiceWorker({} as Navigator)).toBe(false);
    const register = vi.fn(async () => {
      throw new Error("insecure");
    });
    expect(await registerServiceWorker({ serviceWorker: { register } } as unknown as Navigator)).toBe(false);
  });
});
