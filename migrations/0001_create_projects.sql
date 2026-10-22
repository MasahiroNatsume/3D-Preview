CREATE TABLE projects (
  token TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE project_files (
  token TEXT NOT NULL REFERENCES projects(token) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token, filename)
);

CREATE INDEX projects_created_at_idx ON projects(created_at DESC);