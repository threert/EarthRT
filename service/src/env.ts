export interface Env {
  TILES: R2Bucket;
  DB: D1Database;
  ASSETS?: Fetcher;
  /** host of the mirror (user files never come from the app's origin); empty: any host (local dev) */
  FILES_HOST?: string;
  /** host of the app (the web page, /api, /tiles) */
  APP_HOST?: string;
  /** extra origins allowed to read the mirror and the API from a page, comma separated */
  EXTRA_ORIGINS?: string;
  /** optional GitHub token for the hourly discovery (search and stars); writes always use the caller's token */
  GITHUB_TOKEN?: string;
  /** tests: GitHub's API and raw hosts */
  GITHUB_API?: string;
  GITHUB_RAW?: string;
  GITHUB_MEDIA?: string;
  GITHUB_WEB?: string;
}
