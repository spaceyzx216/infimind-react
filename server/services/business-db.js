import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATABASE_PATH = resolve(__dirname, '../data/app.db')

const schema = `
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  invite_code_id TEXT NOT NULL UNIQUE REFERENCES invite_codes(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user_id ON auth_refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_expires_at ON auth_refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  thread_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'thinking',
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  workflow_version TEXT NOT NULL DEFAULT 'contract-review-v1',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  next_run_at TEXT,
  cancel_requested_at TEXT,
  error_code TEXT,
  error_summary TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  result_expires_at TEXT,
  current_stage TEXT,
  stage_summary TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_created_at ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, next_run_at, created_at);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  stage TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);

CREATE TABLE IF NOT EXISTS task_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_task_checkpoints_task_stage ON task_checkpoints(task_id, stage);

CREATE TABLE IF NOT EXISTS task_files (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_path TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  cleanup_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_files_cleanup_at ON task_files(cleanup_at);
`

export function createBusinessDatabase(filename = process.env.BUSINESS_DB_PATH || DEFAULT_DATABASE_PATH) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
  const database = new Database(filename)
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  database.pragma('journal_mode = WAL')
  database.exec(schema)
  // 任务表在已有本地数据库上也要向前兼容；新增字段只承载任务输入快照、对话串行键和阶段摘要，不改变旧认证数据。
  const taskColumns = new Set(database.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name))
  if (!taskColumns.has('thread_id')) database.exec('ALTER TABLE tasks ADD COLUMN thread_id TEXT')
  if (!taskColumns.has('input_json')) database.exec("ALTER TABLE tasks ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}'")
  if (!taskColumns.has('current_stage')) database.exec('ALTER TABLE tasks ADD COLUMN current_stage TEXT')
  if (!taskColumns.has('stage_summary')) database.exec('ALTER TABLE tasks ADD COLUMN stage_summary TEXT')
  database.exec('CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(user_id, product_id, thread_id, status)')
  // 同一用户同一对话同时只允许一个未终态的长任务，起草与审查一致。
  // 插队发送的前端串行是软约束，重复提交或重放请求会绕过它，
  // 因此串行边界必须由数据库原子保证：旧任务进入终态后才允许创建新任务。
  // 这是部分唯一索引，不影响 thread_id 为空的旧任务。
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_contract_draft_thread
    ON tasks(user_id, thread_id)
    WHERE product_id = 'contract-draft'
      AND thread_id IS NOT NULL
      AND status IN ('queued', 'running', 'retry_waiting', 'cancel_requested')
  `)
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_contract_review_thread
    ON tasks(user_id, thread_id)
    WHERE product_id = 'contract-review'
      AND thread_id IS NOT NULL
      AND status IN ('queued', 'running', 'retry_waiting', 'cancel_requested')
  `)
  return database
}

export { DEFAULT_DATABASE_PATH }
