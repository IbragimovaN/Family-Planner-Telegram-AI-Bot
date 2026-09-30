// Applied migrations are immutable: add a new version instead of editing this SQL.
export const migrations = [{
  version: 1,
  name: "initial_family_schema",
  sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT,
  username TEXT,
  photo_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE family_members (
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (family_id, user_id)
) STRICT;
CREATE UNIQUE INDEX family_one_owner ON family_members(family_id) WHERE role = 'owner';
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX invitations_family ON invitations(family_id, expires_at);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE shopping_lists (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  closed_at INTEGER,
  closed_by_user_id TEXT REFERENCES users(id),
  UNIQUE (family_id, id),
  CHECK ((closed_at IS NULL AND closed_by_user_id IS NULL)
    OR (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX shopping_one_open_list ON shopping_lists(family_id) WHERE closed_at IS NULL;
CREATE INDEX shopping_history ON shopping_lists(family_id, closed_at DESC);
CREATE TABLE shopping_items (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  quantity TEXT,
  note TEXT,
  bought INTEGER NOT NULL DEFAULT 0 CHECK (bought IN (0, 1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (family_id, list_id) REFERENCES shopping_lists(family_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX shopping_items_list ON shopping_items(family_id, list_id, bought, created_at);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  period_type TEXT NOT NULL CHECK (period_type IN ('date', 'week', 'month')),
  planned_date TEXT NOT NULL CHECK (length(planned_date) = 10 AND date(planned_date, '+0 days') IS planned_date),
  planned_time TEXT CHECK (planned_time IS NULL OR (length(planned_time) = 5 AND planned_time < '24:00' AND time(planned_time) IS planned_time || ':00')),
  original_period_type TEXT NOT NULL CHECK (original_period_type IN ('date', 'week', 'month')),
  original_planned_date TEXT NOT NULL CHECK (length(original_planned_date) = 10 AND date(original_planned_date, '+0 days') IS original_planned_date),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (family_id, id),
  CHECK ((completed = 0 AND completed_at IS NULL) OR (completed = 1 AND completed_at IS NOT NULL)),
  CHECK (period_type != 'week' OR strftime('%w', planned_date) = '1'),
  CHECK (period_type != 'month' OR substr(planned_date, 9, 2) = '01'),
  CHECK (original_period_type != 'week' OR strftime('%w', original_planned_date) = '1'),
  CHECK (original_period_type != 'month' OR substr(original_planned_date, 9, 2) = '01'),
  CHECK (period_type = 'date' OR planned_time IS NULL)
) STRICT;
CREATE INDEX tasks_owner_period ON tasks(family_id, owner_user_id, completed, period_type, planned_date);
CREATE INDEX tasks_history ON tasks(family_id, owner_user_id, completed_at);
CREATE INDEX tasks_author ON tasks(created_by_user_id);
CREATE TABLE wishlist_profiles (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  avatar_url TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (family_id, id)
) STRICT;
CREATE INDEX wishlist_profiles_family ON wishlist_profiles(family_id, created_at);
CREATE TABLE wishlist_items (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  url TEXT,
  note TEXT,
  price_minor INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  updated_by_user_id TEXT NOT NULL REFERENCES users(id),
  completed_by_user_id TEXT REFERENCES users(id),
  completed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (family_id, profile_id) REFERENCES wishlist_profiles(family_id, id) ON DELETE CASCADE,
  CHECK ((price_minor IS NULL AND currency IS NULL) OR (price_minor IS NOT NULL AND currency IS NOT NULL)),
  CHECK ((completed = 0 AND completed_at IS NULL AND completed_by_user_id IS NULL)
    OR (completed = 1 AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL))
) STRICT;
CREATE INDEX wishlist_items_profile ON wishlist_items(family_id, profile_id, completed, created_at);
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('morning_summary', 'task_created')),
  deduplication_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  sent_at INTEGER,
  telegram_message_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (family_id, user_id, kind, deduplication_key),
  CHECK ((status = 'sent' AND sent_at IS NOT NULL) OR (status != 'sent' AND sent_at IS NULL))
) STRICT;
CREATE INDEX notifications_pending ON notification_deliveries(status, next_attempt_at);
-- Temporary storage for the prototype; never mixed with family tasks.
CREATE TABLE prototype_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX prototype_tasks_created ON prototype_tasks(created_at);
`,
}];
