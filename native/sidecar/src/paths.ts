// Where things are: the one place the sidecar, the `earthrt` command line and native/tools take paths from. The app
// starts the sidecar with EARTHRT_ROOT set to the repository (a development build) or to the app's resources.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The EarthRT repository (or the app's Resources/earthrt): packages/core, the engine. */
export const ROOT = process.env.EARTHRT_ROOT ?? resolve(import.meta.dir, "../../..");
export const ENGINE = join(ROOT, "engine");
export const CORE = join(ROOT, "packages/core/src/index.ts");
/** Build products, the agents' adapters and the `earthrt` launcher (gitignored). */
export const BUILD = process.env.EARTHRT_BUILD ?? join(ROOT, "native/.build");
export const BIN = join(BUILD, "bin");
/** Where the sidecar listens and its token (`{port, pid, token}`, readable by the user only). */
export const SERVER_FILE = join(BUILD, "server.json");
/** Place projects made in the app (Create here, Remix): ARCHITECTURE § 5. */
export const PLACES = process.env.EARTHRT_PLACES ?? join(homedir(), "EarthRT/places");
/** The place template (SPEC § 5, threert/earth-place-template): a git URL or a local folder. */
export const TEMPLATE = process.env.EARTHRT_TEMPLATE ?? "https://github.com/threert/earth-place-template";
/** The registry (SPEC § 8). */
export const API = (process.env.EARTHRT_API ?? "https://earth.threert.dev/api/v1").replace(/\/$/, "");
/** The Bun that runs the sidecar: it also runs the agents' adapters, the command line and the places' tools. */
export const BUN = process.execPath;
