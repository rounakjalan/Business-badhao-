import { afterEach, describe, expect, it, vi } from "vitest";

const { getOrCreate } = vi.hoisted(() => ({ getOrCreate: vi.fn() }));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { getOrCreate } }));

import { attemptSandboxCredentialLogin, isInstagramDiscoverySandboxHostingEnabled, wakeHermesSandboxRuntime } from "@/lib/instagram-discovery/sandbox-runtime";

function makeFakeSandbox() {
  const runCommand = vi.fn();
  const mkDir = vi.fn().mockResolvedValue(undefined);
  const writeFiles = vi.fn().mockResolvedValue(undefined);
  return { runCommand, mkDir, writeFiles };
}

describe("wakeHermesSandboxRuntime", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
  });

  it("never touches the Sandbox SDK when no runtime token is configured", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;

    await wakeHermesSandboxRuntime();

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("never touches the Sandbox SDK when an operator has opted out via INSTAGRAM_DISCOVERY_SANDBOX_DISABLED", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED = "1";

    await wakeHermesSandboxRuntime();

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("syncs runtime files, runs setup, and starts a detached worker when none is already running", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    delete process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED;

    const sandbox = makeFakeSandbox();
    getOrCreate.mockResolvedValue(sandbox);
    sandbox.runCommand
      .mockResolvedValueOnce({ exitCode: 0 }) // setup marker check: already complete
      .mockResolvedValueOnce({ exitCode: 1 }) // pgrep: not already running
      .mockResolvedValueOnce({ exitCode: 0 }); // detached start

    await wakeHermesSandboxRuntime();

    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "hermes-instagram-runtime" }));
    expect(sandbox.writeFiles).toHaveBeenCalled();
    // The last runCommand call is the detached worker launch — never with the
    // bearer token interpolated into `args`/`cmd` text, only via `env`.
    const lastCall = sandbox.runCommand.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ cmd: "node", args: ["worker.mjs"], detached: true });
    expect(lastCall.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN).toBe("secret-token");
    expect(JSON.stringify({ cmd: lastCall.cmd, args: lastCall.args })).not.toContain("secret-token");
    // WORKER_IDLE_EXIT_MS is what makes the woken worker stop promptly once
    // the queue actually empties, instead of idling for the rest of
    // WORKER_MAX_RUNTIME_MS — both must be set so "when discovery finishes,
    // stop the active Instagram job cleanly" actually holds.
    expect(Number(lastCall.env.WORKER_IDLE_EXIT_MS)).toBeGreaterThan(0);
    expect(Number(lastCall.env.WORKER_MAX_RUNTIME_MS)).toBeGreaterThan(Number(lastCall.env.WORKER_IDLE_EXIT_MS));
  });

  it("skips starting a second worker when one is already running", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";

    const sandbox = makeFakeSandbox();
    getOrCreate.mockResolvedValue(sandbox);
    sandbox.runCommand
      .mockResolvedValueOnce({ exitCode: 0 }) // setup marker check: already complete
      .mockResolvedValueOnce({ exitCode: 0 }); // pgrep: already running

    await wakeHermesSandboxRuntime();

    expect(sandbox.runCommand).toHaveBeenCalledTimes(2);
  });

  it("runs Chrome + dependency setup when the marker file is missing, before checking for a running worker", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";

    const sandbox = makeFakeSandbox();
    getOrCreate.mockResolvedValue(sandbox);
    sandbox.runCommand
      .mockResolvedValueOnce({ exitCode: 1 }) // setup marker check: missing
      .mockResolvedValueOnce({ exitCode: 0, stderr: async () => "" }) // setup script itself
      .mockResolvedValueOnce({ exitCode: 1 }) // pgrep: not running
      .mockResolvedValueOnce({ exitCode: 0 }); // detached start

    await wakeHermesSandboxRuntime();

    expect(sandbox.runCommand.mock.calls[1][0]).toBe("bash");
    const setupOpts = sandbox.runCommand.mock.calls[1][2];
    expect(setupOpts).toMatchObject({ timeoutMs: expect.any(Number) });
  });

  it("never throws even when the Sandbox SDK itself fails", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    getOrCreate.mockRejectedValue(new Error("Sandbox API unreachable"));

    await expect(wakeHermesSandboxRuntime()).resolves.toBeUndefined();
  });
});

describe("isInstagramDiscoverySandboxHostingEnabled", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is false with no runtime token configured", () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    expect(isInstagramDiscoverySandboxHostingEnabled()).toBe(false);
  });

  it("is false when an operator opted out via INSTAGRAM_DISCOVERY_SANDBOX_DISABLED", () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED = "1";
    expect(isInstagramDiscoverySandboxHostingEnabled()).toBe(false);
  });

  it("is true when a runtime token is configured and the Sandbox isn't disabled", () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    delete process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED;
    expect(isInstagramDiscoverySandboxHostingEnabled()).toBe(true);
  });
});

describe("attemptSandboxCredentialLogin", () => {
  const originalEnv = { ...process.env };
  const PASSWORD = "correct-horse-battery-staple";

  afterEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
  });

  it("returns an honest error without touching the Sandbox SDK when no runtime is configured", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;

    const result = await attemptSandboxCredentialLogin("org-1", "biz_official", PASSWORD);

    expect(result).toEqual({ ok: false, message: expect.stringContaining("browser runtime is configured") });
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("returns an honest error without touching the Sandbox SDK when an operator opted out of the automatic runtime", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED = "1";

    const result = await attemptSandboxCredentialLogin("org-1", "biz_official", PASSWORD);

    expect(result).toEqual({ ok: false, message: expect.stringContaining("own Hermes runtime") });
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("relays the username/password only via env (never inline in cmd/args) and parses a successful result", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    delete process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED;

    const sandbox = makeFakeSandbox();
    getOrCreate.mockResolvedValue(sandbox);
    sandbox.runCommand
      .mockResolvedValueOnce({ exitCode: 0 }) // setup marker check: already complete
      .mockResolvedValueOnce({ exitCode: 0, stdout: async () => `${JSON.stringify({ ok: true, username: "biz_official" })}\n` }); // credential-login.mjs

    const result = await attemptSandboxCredentialLogin("org-1", "biz_official", PASSWORD);

    expect(result).toEqual({ ok: true, username: "biz_official" });

    const lastCall = sandbox.runCommand.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ cmd: "node", args: ["credential-login.mjs"] });
    expect(lastCall.env.INSTAGRAM_LOGIN_USERNAME).toBe("biz_official");
    expect(lastCall.env.INSTAGRAM_LOGIN_PASSWORD).toBe(PASSWORD);
    expect(lastCall.env.INSTAGRAM_LOGIN_ORG_ID).toBe("org-1");
    expect(JSON.stringify({ cmd: lastCall.cmd, args: lastCall.args })).not.toContain(PASSWORD);
  });

  it("passes through the runtime's own real failure reason rather than fabricating success", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";

    const sandbox = makeFakeSandbox();
    getOrCreate.mockResolvedValue(sandbox);
    sandbox.runCommand
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: async () => JSON.stringify({ ok: false, message: "Sorry, your password was incorrect." }) });

    const result = await attemptSandboxCredentialLogin("org-1", "biz_official", "wrong-password");

    expect(result).toEqual({ ok: false, message: "Sorry, your password was incorrect." });
  });

  it("never throws even when the Sandbox SDK itself fails", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "secret-token";
    getOrCreate.mockRejectedValue(new Error("Sandbox API unreachable"));

    const result = await attemptSandboxCredentialLogin("org-1", "biz_official", PASSWORD);

    expect(result).toEqual({ ok: false, message: expect.any(String) });
  });
});
