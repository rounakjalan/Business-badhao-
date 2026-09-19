import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";

/**
 * Optional, operator-run capability: after login.mjs completes a real,
 * human-supervised Instagram login on THIS machine, push the resulting
 * Chromium profile directory into Business Badhao's own shared, persistent
 * Vercel Sandbox (see src/lib/instagram-discovery/sandbox-runtime.ts on the
 * Business Badhao side) — the thing that actually runs worker.mjs
 * automatically now, with no Docker/systemd machine for an operator to keep
 * running. Without this, a login performed on a laptop/local machine would
 * only ever be usable by a worker.mjs also run on that exact same machine
 * (the original, still-supported Docker/systemd deployment) — this is what
 * lets that one-time login also feed the on-demand Sandbox runtime.
 *
 * Deliberately NOT automatic and NOT required: login.mjs itself never
 * imports this unconditionally, and never sees a password either way — see
 * login.mjs's own doc comment. This only runs when the operator has opted
 * in by setting VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID (see
 * README.md's "Connecting to the on-demand Sandbox runtime" section for
 * exactly where each of those comes from) — an operator who runs their own
 * Docker/systemd deployment instead (INSTAGRAM_DISCOVERY_SANDBOX_DISABLED)
 * has no reason to set them and this is simply never invoked.
 *
 * Known limitation, stated plainly rather than hidden: Chromium's own
 * cookie/session encryption can be tied to the OS/keyring of the machine
 * that created the profile. Running login.mjs inside a plain Linux
 * environment with no keyring service available (a bare `docker run`, a
 * throwaway Linux VM — never a desktop Linux/macOS/Windows session with a
 * real keyring) keeps this consistent with the Sandbox's own environment,
 * which is the configuration this was verified against.
 */

const SANDBOX_NAME = "hermes-instagram-runtime";
const HERMES_DIR = "/vercel/sandbox/hermes";
const SAFE_PROFILE_REF = /^[A-Za-z0-9_-]+$/;
/** A real profile after a real login is normally a few MB across a few hundred files (verified: a freshly-launched, never-navigated Chromium profile is already ~150 files/~3MB of its own component/shader caches before any real browsing) — this is a sanity ceiling against pushing an unexpectedly huge directory (e.g. a profile an operator reused across many other sites), not a realistic limit for what login.mjs itself produces. */
const MAX_FILES = 5000;
const WRITE_CHUNK_SIZE = 150;

export function sandboxPushConfigured() {
  return Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID);
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path.relative(rootDir, full));
      if (out.length > MAX_FILES) throw new Error(`Profile directory has more than ${MAX_FILES} files — refusing to push (see MAX_FILES's own doc comment).`);
    }
  }
  await walk(rootDir);
  return out;
}

/**
 * @param organizationId Business Badhao organization id — also the local
 *   profile directory name (see login.mjs/lib/browser.mjs) and the
 *   directory this writes to under the shared Sandbox's own PROFILES_DIR.
 * @param profileDir Absolute local path to that organization's Chromium
 *   profile directory (PROFILES_DIR/<organizationId>).
 */
export async function pushProfileToSandbox(organizationId, profileDir) {
  if (!organizationId || !SAFE_PROFILE_REF.test(organizationId)) {
    throw new Error(`Refusing to push an unsafe or missing organizationId: ${JSON.stringify(organizationId)}`);
  }

  const sandbox = await Sandbox.getOrCreate({
    name: SANDBOX_NAME,
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
    timeout: 10 * 60_000,
    resources: { vcpus: 2 },
  });

  const relativeFiles = await listFilesRecursive(profileDir);
  const targetDir = `${HERMES_DIR}/profiles/${organizationId}`;
  await sandbox.mkDir(targetDir);

  for (let i = 0; i < relativeFiles.length; i += WRITE_CHUNK_SIZE) {
    const batch = relativeFiles.slice(i, i + WRITE_CHUNK_SIZE);
    const files = await Promise.all(
      batch.map(async (rel) => ({
        path: `${targetDir}/${rel.split(path.sep).join("/")}`,
        content: await readFile(path.join(profileDir, rel)),
      }))
    );
    await sandbox.writeFiles(files);
  }

  return { ok: true, fileCount: relativeFiles.length };
}
