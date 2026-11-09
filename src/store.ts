import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BridgeError, now, type Task, type BridgeEvent } from "./domain.js";

export class Store {
  private db: DatabaseSync;
  private lock: string;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    this.lock = join(dir, "coordinator.lock");
    try {
      closeSync(openSync(this.lock, "wx"));
    } catch {
      const owner = Number(readFileSync(this.lock, "utf8"));
      // Empty/invalid ownership is ambiguous; never steal a live coordinator's lock.
      if (!Number.isSafeInteger(owner) || owner <= 0)
        throw new Error(
          "Coordinator lock is invalid; inspect before removing it",
        );
      let alive = true;
      try {
        process.kill(owner, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error("Another coordinator owns this data directory");
      unlinkSync(this.lock);
      closeSync(openSync(this.lock, "wx"));
    }
    writeFileSync(this.lock, String(process.pid));
    this.db = new DatabaseSync(join(dir, "bridge.db"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  value<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  setValue(key: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(data));
  }
  insert(task: Task, idem: string, hash: string) {
    this.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?)")
      .run(task.id, idem, hash, JSON.stringify(task));
  }
  byKey(key: string): { task: Task; hash: string } | undefined {
    const row = this.db
      .prepare("SELECT data,request_hash FROM tasks WHERE idem=?")
      .get(key);
    return row
      ? { task: JSON.parse(String(row.data)), hash: String(row.request_hash) }
      : undefined;
  }
  get(id: string): Task {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    if (!row) throw new BridgeError("NOT_FOUND", "Task not found");
    return JSON.parse(String(row.data));
  }
  all(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.data)));
  }
  save(task: Task) {
    this.db
      .prepare("UPDATE tasks SET data=? WHERE id=?")
      .run(JSON.stringify(task), task.id);
  }
  event(task: Task, type: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO events(task_id,attempt_id,type,data,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        task.id,
        task.attempts.at(-1)!.id,
        type,
        JSON.stringify(data),
        now(),
      );
  }
  events(id: string, after = 0, limit = 100): BridgeEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT ?",
      )
      .all(id, after, limit)
      .map((r) => ({
        cursor: Number(r.cursor),
        taskId: String(r.task_id),
        attemptId: String(r.attempt_id),
        type: String(r.type),
        data: JSON.parse(String(r.data)),
        createdAt: String(r.created_at),
      }));
  }
  close() {
    this.db.close();
    unlinkSync(this.lock);
  }
}
