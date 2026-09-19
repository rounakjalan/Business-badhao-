import { afterEach, describe, expect, it, vi } from "vitest";

const { getOrCreate } = vi.hoisted(() => ({ getOrCreate: vi.fn() }));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { getOrCreate } }));

import { wakeHermesSandboxRuntime } from "@/lib/instagram-discovery/sandbox-runtime";

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
