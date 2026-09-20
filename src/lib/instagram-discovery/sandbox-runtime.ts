import "server-only";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { getSiteUrl } from "@/lib/site-url";

/**
 * Business Badhao's own hosting for hermes-browser-runtime's existing
 * worker.mjs — the piece the rest of this task's requirement calls "the
 * hosting/runtime issue": Vercel's serverless request model cannot keep a
 * persistent, authenticated Chromium process running, so something has to
 * actually run worker.mjs somewhere real. Before this module, that
 * "somewhere" had to be a machine an operator provisioned and ran Docker/
 * systemd on by hand (see hermes-browser-runtime/README.md). This module
 * makes Business Badhao provision and run it instead, using Vercel Sandbox
 * (real Linux MicroVMs Vercel already offers this project's own deployment,
 * authenticated automatically via this function's own ambient Vercel OIDC
 * token — see README's Authentication section) — so the person operating a
 * Business Badhao deployment never runs a docker/systemd command, and the
 * org admin who clicks "Find Leads" never sees any of this exists.
 *
 * What actually changes vs. the manually-operated deployment: nothing about
 * worker.mjs's own job-processing logic, Chromium driving, or organization
 * profile isolation (PROFILES_DIR/<organizationId>, lib/browser.mjs's
 * SAFE_PROFILE_REF check) — this module only answers "who starts worker.mjs,
 * and where." One shared, persistent, named Sandbox hosts the exact same
 * worker.mjs for every organization (mirroring the existing Docker/systemd
 * deployment, which is also one process serving every organization's own
 * profile subdirectory) — never one Sandbox per organization: organization
 * isolation already comes from the profile directory, not from the VM
 * boundary, and reusing one Sandbox is what keeps this from provisioning and
 * paying for N idle Linux VMs.
 *
 * Since a Sandbox session is a bounded-duration VM, not a perpetual daemon
 * (its filesystem persists across stop/resume; a running process does not —
 * see Vercel's own Sandbox persistence docs), this wakes the sandbox and
 * (re)starts worker.mjs on demand, right when a real job exists for it to
 * do. worker.mjs's own graceful-shutdown handling then ends that one run in
 * either of two ways, both added alongside this module (see worker.mjs):
 * WORKER_IDLE_EXIT_MS stops it within ~30s of the queue actually going empty
 * (the common case — "when discovery finishes, stop the active Instagram
 * job cleanly"), and WORKER_MAX_RUNTIME_MS is the outer safety ceiling in
 * case jobs keep arriving. Either way it exits on its own; nothing tries to
 * keep a VM running forever. This is deliberately called from the SAME
 * places that already create a job (InstagramDiscoveryTool.search,
 * testInstagramDiscoveryConnectionAction) — never a new schedule/cron of its
 * own — so a Sandbox only ever spins up because a real discovery or
 * connection-test run needs one answered.
 *
 * Also runs the one-time Instagram login itself, via
 * attemptSandboxCredentialLogin below, when Settings' own username/password
 * form submits one: this Sandbox has no attached display for a human to use
 * login.mjs's original manual-entry flow, so credential-login.mjs (a
 * separate script, invoked non-detached, once) submits the login
 * programmatically instead. The password never reaches Business Badhao's
 * own database — it flows in memory from the Settings form straight into
 * this Sandbox command's own `env`, is read only by credential-login.mjs,
 * and is discarded the moment that one process exits. Self-hosted operators
 * (INSTAGRAM_DISCOVERY_SANDBOX_DISABLED) are unaffected: they still use
 * login.mjs's original human-supervised flow, unchanged — see its own doc
 * comment and README.md.
 */

const SANDBOX_NAME = "hermes-instagram-runtime";
const HERMES_DIR = "/vercel/sandbox/hermes";
const CHROMIUM_EXECUTABLE_PATH = "/usr/bin/google-chrome-stable";
const SANDBOX_VCPUS = 2;
/** How long the underlying Sandbox VM session stays allocated once woken — comfortably longer than WORKER_RUN_WINDOW_MS so back-to-back wakes from the same "Find Leads" run (several queries, each its own job) reuse the same warm session instead of paying a fresh resume/setup cost each time. */
const SANDBOX_SESSION_TIMEOUT_MS = 10 * 60_000;
/** How long a woken worker.mjs drains the queue before exiting gracefully (WORKER_MAX_RUNTIME_MS) — generous relative to a single job's own bounded poll (InstagramDiscoveryTool's default 60s, jobs.ts's own JOB_TTL_MS 120s) so it has real room to claim and finish the job(s) that just triggered this wake, plus whatever else is already queued, without staying up indefinitely once idle. */
const WORKER_RUN_WINDOW_MS = 150_000;
/** How long the woken worker waits with an empty queue before exiting early (WORKER_IDLE_EXIT_MS) — "when discovery finishes, stop the active Instagram discovery job cleanly" — rather than idling for the rest of WORKER_RUN_WINDOW_MS. Comfortably longer than a poll interval (worker.mjs's own default 4s) so a brief lull between two queries of the same batch is never mistaken for the run being over. */
const WORKER_IDLE_EXIT_MS = 30_000;
const SETUP_TIMEOUT_MS = 5 * 60_000;

/**
 * Escape hatch for an operator who wants to run their own external runtime
 * (the original Docker/systemd deployment, e.g. for more control or a
 * dedicated machine) instead of this on-demand Sandbox — never required,
 * unset by default. Named distinctly from
 * INSTAGRAM_DISCOVERY_RUNTIME_TOKEN so turning this off can never be
 * confused with turning Instagram discovery off entirely.
 */
function sandboxHostingDisabled(): boolean {
  return process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED === "1" || process.env.INSTAGRAM_DISCOVERY_SANDBOX_DISABLED === "true";
}

/** Whether Settings should show the username/password Connect form (this Sandbox is what would actually run the login) rather than the login.mjs command hint for a self-hosted runtime. */
export function isInstagramDiscoverySandboxHostingEnabled(): boolean {
  return Boolean(process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN) && !sandboxHostingDisabled();
}

/**
 * hermes-browser-runtime's own source files, read off this deployment's own
 * filesystem (see next.config.ts's outputFileTracingIncludes for why they're
 * present in production at all) and uploaded into the Sandbox verbatim —
 * the exact same worker.mjs/credential-login.mjs/lib code the manually-
 * operated Docker/systemd deployment ships, never a reimplementation. Only
 * source files: node_modules is deliberately excluded (the Sandbox runs
 * `npm ci` itself, against its own OS/architecture — see runSetup) and
 * login.mjs is deliberately excluded (it assumes a human at a real display;
 * it is never meant to run unattended inside this on-demand Sandbox — see
 * this module's own doc comment).
 */
async function collectRuntimeFiles(): Promise<{ path: string; content: Buffer }[]> {
  const root = path.join(process.cwd(), "hermes-browser-runtime");
  const files: { path: string; content: Buffer }[] = [];

  for (const name of ["worker.mjs", "credential-login.mjs", "package.json", "package-lock.json"]) {
    files.push({ path: name, content: await readFile(path.join(root, name)) });
  }

  const libDir = path.join(root, "lib");
  for (const entry of await readdir(libDir)) {
    if (!entry.endsWith(".mjs")) continue;
    files.push({ path: `lib/${entry}`, content: await readFile(path.join(libDir, entry)) });
  }

  return files;
}

async function ensureSandbox(): Promise<Sandbox> {
  return Sandbox.getOrCreate({
    name: SANDBOX_NAME,
    timeout: SANDBOX_SESSION_TIMEOUT_MS,
    resources: { vcpus: SANDBOX_VCPUS },
  });
}

/**
 * Re-uploads the current deployment's runtime source on every wake (cheap —
 * a handful of small text files) so a Sandbox that has been sitting idle
 * for days still runs whatever worker.mjs this deployment currently ships,
 * never a stale copy from whenever the Sandbox happened to be created.
 *
 * Uses `mkdir -p` via runCommand rather than sandbox.mkDir: on a genuinely
 * brand-new sandbox (nothing under /vercel/sandbox/hermes yet at all),
 * mkDir(".../hermes/lib") does not create the missing parent
 * (.../hermes) itself and fails with "No such file or directory" — a real
 * failure found via live production verification (the very first
 * credential-login attempt against a freshly created sandbox), not a
 * hypothetical.
 */
async function syncRuntimeFiles(sandbox: Sandbox): Promise<void> {
  const files = await collectRuntimeFiles();
  const mkdir = await sandbox.runCommand("mkdir", ["-p", `${HERMES_DIR}/lib`], { timeoutMs: 15_000 });
  if (mkdir.exitCode !== 0) {
    const stderr = await mkdir.stderr().catch(() => "");
    throw new Error(`Could not create ${HERMES_DIR}/lib in the Sandbox (exit ${mkdir.exitCode}): ${stderr.slice(-500)}`);
  }
  await sandbox.writeFiles(files.map((f) => ({ path: `${HERMES_DIR}/${f.path}`, content: f.content })));
}

/**
 * One-time-per-sandbox-filesystem setup: a real Google Chrome binary (the
 * `chromium` apt package resolves to a broken snap-stub on this Sandbox
 * image's Ubuntu release — installing Google's own .deb directly is the
 * fix that was actually verified working) and this package's one real
 * dependency (puppeteer-core, via the checked-in package-lock.json).
 * Guarded by a marker file so a normal wake never re-runs it — but the
 * marker is only written after every step below succeeds, so a wake that
 * follows a previously-failed/partial setup retries it rather than being
 * permanently stuck.
 */
async function runSetupIfNeeded(sandbox: Sandbox): Promise<void> {
  const check = await sandbox.runCommand("test", ["-f", `${HERMES_DIR}/.setup-complete`], { timeoutMs: 10_000 });
  if (check.exitCode === 0) return;

  const script = [
    "set -e",
    "sudo apt-get update -qq",
    "sudo apt-get install -y -qq wget ca-certificates fonts-liberation",
    "wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb",
    "sudo apt-get install -y -qq /tmp/google-chrome.deb",
    "rm -f /tmp/google-chrome.deb",
    `cd ${HERMES_DIR} && npm ci --omit=dev --loglevel=error`,
    `touch ${HERMES_DIR}/.setup-complete`,
  ].join(" && ");

  const result = await sandbox.runCommand("bash", ["-lc", script], { timeoutMs: SETUP_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    const stderr = await result.stderr().catch(() => "");
    throw new Error(`Sandbox setup failed (exit ${result.exitCode}): ${stderr.slice(-2000)}`);
  }
}

/**
 * True if a worker.mjs launched by an earlier wake (possibly from a
 * different serverless invocation entirely — nothing about a `Command`
 * handle survives across those) is still alive. Checked against the
 * Sandbox's real process table, not any bookkeeping file this module
 * writes, so a worker that exited for any reason (its own
 * WORKER_MAX_RUNTIME_MS, a crash, the Sandbox session having restarted) is
 * correctly seen as "not running" with nothing to reconcile.
 */
async function workerAlreadyRunning(sandbox: Sandbox): Promise<boolean> {
  const check = await sandbox.runCommand("pgrep", ["-f", "node worker.mjs"], { timeoutMs: 10_000 });
  return check.exitCode === 0;
}

/**
 * Launches the existing worker.mjs detached — the SDK's own documented
 * mechanism for a command that must outlive this call (see @vercel/sandbox's
 * README) — bounded by WORKER_MAX_RUNTIME_MS so it drains the current queue
 * and exits (worker.mjs's own graceful shutdown — see that file) rather than
 * trying to run forever inside a Sandbox session that will itself eventually
 * stop. The bearer token is passed via `env` — never interpolated into a
 * shell command string, which would otherwise leak it into this Sandbox's
 * own command-history/log metadata.
 */
async function startWorker(sandbox: Sandbox, runtimeToken: string): Promise<void> {
  await sandbox.runCommand({
    cmd: "node",
    args: ["worker.mjs"],
    cwd: HERMES_DIR,
    detached: true,
    env: {
      BUSINESS_BADHAO_API_URL: getSiteUrl(),
      INSTAGRAM_DISCOVERY_RUNTIME_TOKEN: runtimeToken,
      CHROMIUM_EXECUTABLE_PATH,
      CHROMIUM_EXTRA_ARGS: "--no-sandbox --disable-dev-shm-usage",
      PROFILES_DIR: `${HERMES_DIR}/profiles`,
      WORKER_MAX_RUNTIME_MS: String(WORKER_RUN_WINDOW_MS),
      WORKER_IDLE_EXIT_MS: String(WORKER_IDLE_EXIT_MS),
      WORKER_CONCURRENCY: "2",
    },
  });
}

/**
 * Called right after a real discovery/verification job is created
 * (InstagramDiscoveryTool.search, testInstagramDiscoveryConnectionAction) —
 * never on any schedule of its own. Ensures a real worker.mjs is actively
 * polling for that job, hosted by this deployment's own Sandbox, with no
 * operator action required. Never throws: a Sandbox problem must degrade to
 * "the job sits pending until it expires, honestly reported as a timeout by
 * pollInstagramDiscoveryJobResult" — exactly the existing failure mode when
 * no runtime answers in time — never break the job-creation call it's
 * attached to.
 */
export async function wakeHermesSandboxRuntime(): Promise<void> {
  const runtimeToken = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
  if (!runtimeToken || sandboxHostingDisabled()) return;

  try {
    const sandbox = await ensureSandbox();
    await syncRuntimeFiles(sandbox);
    await runSetupIfNeeded(sandbox);
    if (!(await workerAlreadyRunning(sandbox))) {
      await startWorker(sandbox, runtimeToken);
    }
  } catch (error) {
    console.error("[instagram-discovery] wakeHermesSandboxRuntime failed — falling back to whatever external runtime (if any) is polling", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** How long one credential-login.mjs run may take — generous for a cold Sandbox (Chrome + npm ci, up to SETUP_TIMEOUT_MS the first time ever) on top of submitCredentialLogin's own internal wait (up to 45s). */
const CREDENTIAL_LOGIN_TIMEOUT_MS = 6 * 60_000;

export type SandboxCredentialLoginResult = { ok: true; username: string } | { ok: false; message: string };

/**
 * Called from Settings' username/password "Connect Instagram" form
 * (connectInstagramWithCredentialsAction). Runs credential-login.mjs
 * non-detached inside this same shared Sandbox and awaits its real result —
 * unlike wakeHermesSandboxRuntime, this is NOT fire-and-forget, since the
 * user is on the page waiting to see Connected/an error.
 *
 * The username and password are passed via this command's own `env` only —
 * never written to Supabase, never interpolated into a shell/command
 * string, never logged by this function. They live in this function's own
 * memory for exactly as long as this call takes, then go out of scope; nothing
 * in Business Badhao's own code path retains them afterward.
 */
export async function attemptSandboxCredentialLogin(organizationId: string, username: string, password: string): Promise<SandboxCredentialLoginResult> {
  const runtimeToken = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
  if (!runtimeToken) {
    return { ok: false, message: "No Instagram discovery browser runtime is configured for this deployment yet." };
  }
  if (sandboxHostingDisabled()) {
    return {
      ok: false,
      message: "This deployment is configured to use your own Hermes runtime instead of the automatic one — run login.mjs there (see the command below).",
    };
  }

  try {
    const sandbox = await ensureSandbox();
    await syncRuntimeFiles(sandbox);
    await runSetupIfNeeded(sandbox);

    const result = await sandbox.runCommand({
      cmd: "node",
      args: ["credential-login.mjs"],
      cwd: HERMES_DIR,
      timeoutMs: CREDENTIAL_LOGIN_TIMEOUT_MS,
      env: {
        BUSINESS_BADHAO_API_URL: getSiteUrl(),
        INSTAGRAM_DISCOVERY_RUNTIME_TOKEN: runtimeToken,
        CHROMIUM_EXECUTABLE_PATH,
        CHROMIUM_EXTRA_ARGS: "--no-sandbox --disable-dev-shm-usage",
        PROFILES_DIR: `${HERMES_DIR}/profiles`,
        INSTAGRAM_LOGIN_ORG_ID: organizationId,
        INSTAGRAM_LOGIN_USERNAME: username,
        INSTAGRAM_LOGIN_PASSWORD: password,
      },
    });

    const stdout = await result.stdout().catch(() => "");
    const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
    if (!lastLine) {
      return { ok: false, message: "The Instagram browser runtime didn't report a result. Please try again." };
    }

    const parsed = JSON.parse(lastLine) as { ok: boolean; username?: string; message?: string };
    return parsed.ok && parsed.username ? { ok: true, username: parsed.username } : { ok: false, message: parsed.message ?? "Instagram login failed." };
  } catch (error) {
    console.error("[instagram-discovery] attemptSandboxCredentialLogin failed", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, message: "Could not reach the Instagram browser runtime. Please try again." };
  }
}
