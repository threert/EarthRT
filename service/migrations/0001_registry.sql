-- The places registry (SPEC § 8).
CREATE TABLE places (
  id TEXT PRIMARY KEY,               -- <owner>/<repo>/<manifest id>, lower case
  repo TEXT NOT NULL,                -- <owner>/<repo> as GitHub spells it
  path TEXT NOT NULL DEFAULT '',     -- directory of earthrt.json in the repository ('' = root)
  sha TEXT NOT NULL,                 -- the commit served
  manifest TEXT NOT NULL,            -- JSON
  topic TEXT NOT NULL,
  topic_base TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL,
  west REAL NOT NULL, south REAL NOT NULL, east REAL NOT NULL, north REAL NOT NULL,
  author TEXT NOT NULL,              -- GitHub login that registered it (the owner, for discovered ones)
  author_id INTEGER,
  stars INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,              -- 'api' | 'topic'
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX places_box ON places (south, north);
CREATE INDEX places_topic ON places (topic_base);
CREATE INDEX places_repo ON places (repo);

-- every commit a place has been served at (the mirror serves only these)
CREATE TABLE versions (
  repo TEXT NOT NULL,                -- lower case
  sha TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, sha)
);

CREATE TABLE likes (
  place TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (place, user_id)
);

-- discovery's memory: what it saw and why a repository was not registered
CREATE TABLE crawl (
  repo TEXT PRIMARY KEY,
  checked TEXT NOT NULL,
  pushed TEXT,
  error TEXT
);
