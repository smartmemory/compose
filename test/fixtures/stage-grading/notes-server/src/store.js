// Notes store over SQLite (node:sqlite, no dependencies).
// The shared stage-grading scenario: write / search / recall notes.

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
`;

const MAX_LIMIT = 100;

export class NotesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// LIKE treats % and _ as wildcards; a query is matched literally.
function likePattern(query) {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new NotesError('INVALID', 'tags must be an array of strings');
  const out = new Set();
  for (const t of tags) {
    if (typeof t !== 'string' || !t.trim()) throw new NotesError('INVALID', 'each tag must be a non-empty string');
    out.add(t.trim().toLowerCase());
  }
  return [...out].sort();
}

export class NotesStore {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.clock = () => new Date().toISOString();
  }

  write({ title, body, tags } = {}) {
    if (typeof title !== 'string' || !title.trim()) throw new NotesError('INVALID', 'title is required');
    if (typeof body !== 'string') throw new NotesError('INVALID', 'body must be a string');
    const cleanTags = normalizeTags(tags);
    const createdAt = this.clock();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)')
      .run(title.trim(), body, createdAt);
    const id = Number(lastInsertRowid);
    const addTag = this.db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)');
    for (const tag of cleanTags) addTag.run(id, tag);
    return this.recall(id);
  }

  // Partial update: only the fields present change; tags, when given, replace the note's tag set.
  update(id, { title, body, tags } = {}) {
    if (!Number.isInteger(id) || id < 1) throw new NotesError('INVALID', 'id must be a positive integer');
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw new NotesError('INVALID', 'title must be a non-empty string');
    if (body !== undefined && typeof body !== 'string') throw new NotesError('INVALID', 'body must be a string');
    const cleanTags = tags === undefined ? undefined : normalizeTags(tags);
    if (!this.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) return null;
    if (title !== undefined) this.db.prepare('UPDATE notes SET title = ? WHERE id = ?').run(title.trim(), id);
    if (body !== undefined) this.db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(body, id);
    if (cleanTags !== undefined) this.#replaceTags(id, cleanTags);
    return this.recall(id);
  }

  // Bulk load of {title, body, tags?, createdAt?} rows (the seed notes in src/seed.js); returns the new ids.
  importNotes(rows) {
    if (!Array.isArray(rows)) throw new NotesError('INVALID', 'rows must be an array');
    const ids = [];
    for (const row of rows) {
      const { title, body, tags, createdAt } = row ?? {};
      if (typeof title !== 'string' || !title.trim()) throw new NotesError('INVALID', 'title is required');
      if (typeof body !== 'string') throw new NotesError('INVALID', 'body must be a string');
      const cleanTags = normalizeTags(tags);
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)')
        .run(title.trim(), body, createdAt ?? this.clock());
      const id = Number(lastInsertRowid);
      this.#replaceTags(id, cleanTags);
      ids.push(id);
    }
    return ids;
  }

  recall(id) {
    if (!Number.isInteger(id) || id < 1) throw new NotesError('INVALID', 'id must be a positive integer');
    const row = this.db.prepare('SELECT id, title, body, created_at FROM notes WHERE id = ?').get(id);
    return row ? this.#hydrate(row) : null;
  }

  search(query, { tag, limit = 10 } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new NotesError('INVALID', 'query is required');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new NotesError('INVALID', `limit must be an integer in 1..${MAX_LIMIT}`);
    }
    const params = { p: likePattern(query.trim()), limit };
    let sql = 'SELECT DISTINCT n.id, n.title, n.body, n.created_at FROM notes n';
    if (tag !== undefined) {
      sql += ' JOIN note_tags t ON t.note_id = n.id AND t.tag = $tag';
      params.tag = normalizeTags([tag])[0];
    }
    sql += " WHERE (n.title LIKE $p ESCAPE '\\'";
    sql += " OR n.body LIKE $p ESCAPE '\\')";
    sql += ' ORDER BY n.created_at DESC, n.id DESC LIMIT $limit';
    return this.db.prepare(sql).all(params).map((row) => this.#hydrate(row));
  }

  remove(id) {
    if (!Number.isInteger(id) || id < 1) throw new NotesError('INVALID', 'id must be a positive integer');
    return this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes === 1;
  }

  close() {
    this.db.close();
  }

  #replaceTags(id, tags) {
    this.db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id);
    const addTag = this.db.prepare('INSERT INTO note_tags (note_id, tag) VALUES (?, ?)');
    for (const tag of tags) addTag.run(id, tag);
  }

  #hydrate(row) {
    const tags = this.db
      .prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY tag')
      .all(row.id)
      .map((t) => t.tag);
    return { id: row.id, title: row.title, body: row.body, tags, createdAt: row.created_at };
  }
}
