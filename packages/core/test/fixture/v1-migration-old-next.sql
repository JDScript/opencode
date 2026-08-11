CREATE TABLE project (
  id text PRIMARY KEY,
  worktree text NOT NULL,
  vcs text,
  name text,
  icon_url text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_initialized integer,
  sandboxes text NOT NULL
);

CREATE TABLE session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  fork_session_id text,
  fork_message_id text,
  fork_seq integer,
  slug text NOT NULL,
  directory text NOT NULL,
  path text,
  title text,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer
);

CREATE TABLE session_message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  seq integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

INSERT INTO project (
  id, worktree, vcs, name, icon_url, time_created, time_updated, time_initialized, sandboxes
) VALUES (
  'old-project', '/tmp/old-next', 'git', 'Old project', 'https://example.test/icon.png', 1, 2, 3, '[]'
);

INSERT INTO session (
  id, project_id, fork_session_id, fork_message_id, fork_seq, slug, directory, title, version,
  time_created, time_updated
) VALUES (
  'ses_old_next', 'old-project', 'ses_parent', 'msg_parent', 4, 'old-next', '/tmp/old-next',
  'Old imported session', '2', 10, 20
);

INSERT INTO session_message VALUES (
  'msg_old_next', 'ses_old_next', 'user', 0, 12, 13, '{"text":"from old next","time":{"created":12}}'
);
