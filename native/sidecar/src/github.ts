// GitHub sign-in for Publish and likes (SPEC § 8: writes take a GitHub token). Two ways in:
// - the `gh` command line's token, when `gh` is installed and logged in (`gh auth token`): nothing to do;
// - GitHub's device flow (https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
//   with EarthRT's OAuth App: the app shows a code, the user enters it at github.com/login/device, the token comes
//   back. It needs the OAuth App's client id (EARTHRT_GITHUB_CLIENT_ID, or the app's setting): an OAuth App the
//   project's owner creates once on github.com with "Enable Device Flow" ticked (no secret is needed for it).
// The token is the app's to keep (the Keychain); the sidecar holds it only for the commands that use it.
import { findBinary } from "./agent/adapters.ts";
import { run } from "./places.ts";

export const DEVICE_SCOPE = "public_repo";

/** `gh auth token`, or null when gh is not there or not logged in. */
export async function ghToken(): Promise<string | null> {
  const gh = findBinary("gh");
  if (!gh) return null;
  const r = await run([gh, "auth", "token"], process.cwd());
  const t = r.out.trim();
  return r.code === 0 && t ? t : null;
}

export interface GitHubUser { login: string; id: number; name?: string | null; avatar_url?: string }

export async function whoami(token: string, f: typeof fetch = fetch): Promise<GitHubUser> {
  const r = await f("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "EarthRT" } });
  if (!r.ok) throw new Error(`GitHub: ${r.status} ${r.statusText}`);
  const u = await r.json() as GitHubUser;
  return { login: u.login, id: u.id, name: u.name, avatar_url: u.avatar_url };
}

export interface DeviceCode { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }

export async function deviceStart(clientId: string, f: typeof fetch = fetch): Promise<DeviceCode> {
  if (!clientId) throw new Error("GitHub sign-in needs EarthRT's OAuth App client id (EARTHRT_GITHUB_CLIENT_ID); until then, `gh auth login` works");
  const r = await f("https://github.com/login/device/code", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "EarthRT" },
    body: JSON.stringify({ client_id: clientId, scope: DEVICE_SCOPE }),
  });
  const j = await r.json() as DeviceCode & { error?: string; error_description?: string };
  if (!r.ok || j.error) throw new Error(`GitHub: ${j.error_description ?? j.error ?? r.status}`);
  return j;
}

/** Polls for the device flow's token until the user entered the code (or it expired, or was refused). */
export async function devicePoll(clientId: string, code: DeviceCode, o: { f?: typeof fetch; sleep?: (ms: number) => Promise<void>; canceled?: () => boolean } = {}): Promise<string> {
  const f = o.f ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise(done => setTimeout(done, ms)));
  let interval = Math.max(1, code.interval || 5);
  const until = Date.now() + (code.expires_in || 900) * 1000;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    if (o.canceled?.()) throw new Error("canceled");
    const r = await f("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "EarthRT" },
      body: JSON.stringify({ client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = await r.json() as { access_token?: string; error?: string; error_description?: string; interval?: number };
    if (j.access_token) return j.access_token;
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") { interval = j.interval ?? interval + 5; continue; }
    throw new Error(`GitHub: ${j.error_description ?? j.error ?? r.status}`);
  }
  throw new Error("GitHub: the code expired; sign in again");
}
