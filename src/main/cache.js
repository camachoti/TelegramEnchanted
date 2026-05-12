import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { Database } = require('node-sqlite3-wasm');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER NOT NULL,
    chat_id         TEXT    NOT NULL,
    topic_id        INTEGER DEFAULT NULL,
    data            TEXT    NOT NULL,
    original_data   TEXT    DEFAULT NULL,
    is_deleted      INTEGER DEFAULT 0,
    is_edited       INTEGER DEFAULT 0,
    cached_at       INTEGER NOT NULL,
    last_accessed   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, topic_id, id);

CREATE TABLE IF NOT EXISTS media_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id         TEXT    NOT NULL,
    message_id      INTEGER NOT NULL,
    media_type      TEXT    NOT NULL,
    file_path       TEXT    NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    mime_type       TEXT    DEFAULT NULL,
    cached_at       INTEGER NOT NULL,
    last_accessed   INTEGER NOT NULL,
    UNIQUE(chat_id, message_id, media_type)
);

CREATE TABLE IF NOT EXISTS avatars (
    chat_id         TEXT    PRIMARY KEY,
    file_path       TEXT    NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    cached_at       INTEGER NOT NULL,
    last_accessed   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key             TEXT    PRIMARY KEY,
    value           TEXT    NOT NULL
);
`;

export class CacheManager {
  constructor(userDataPath) {
    this._cacheDir = path.join(userDataPath, 'cache');
    this._avatarsDir = path.join(this._cacheDir, 'avatars');
    this._thumbnailsDir = path.join(this._cacheDir, 'thumbnails');
    this._photosDir = path.join(this._cacheDir, 'photos');
    this._videosDir = path.join(this._cacheDir, 'videos');

    for (const dir of [this._cacheDir, this._avatarsDir, this._thumbnailsDir, this._photosDir, this._videosDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    this._db = new Database(path.join(this._cacheDir, 'cache.db'));
    this._db.exec(SCHEMA);

    // Insert default settings if not present
    this._db.run(
      `INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)`,
      ['max_cache_size', '0']
    );
    this._db.run(
      `INSERT OR IGNORE INTO settings(key, value) VALUES(?,?)`,
      ['avatar_refresh_hours', '24']
    );
  }

  close() {
    try { this._db.close(); } catch (_) {}
  }

  // ── Settings ────────────────────────────────────────────────

  getSetting(key) {
    const row = this._db.get(`SELECT value FROM settings WHERE key=?`, [key]);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this._db.run(
      `INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)`,
      [key, String(value)]
    );
  }

  // ── Messages ─────────────────────────────────────────────────

  /**
   * Upsert a batch of messages. Detects edits by comparing stored JSON text.
   * @param {string} chatId
   * @param {number|null} topicId
   * @param {object[]} messages  – already-serialisable renderer Message objects
   */
  cacheMessages(chatId, topicId, messages) {
    const now = Date.now();
    for (const msg of messages) {
      const newData = JSON.stringify(msg);
      const existing = this._db.get(
        `SELECT data, is_deleted, original_data FROM messages WHERE chat_id=? AND id=?`,
        [chatId, msg.id]
      );

      if (existing) {
        if (existing.is_deleted) {
          // Message was deleted — keep marker, just touch
          this._db.run(
            `UPDATE messages SET last_accessed=? WHERE chat_id=? AND id=?`,
            [now, chatId, msg.id]
          );
          continue;
        }

        const oldParsed = JSON.parse(existing.data);
        const textChanged = oldParsed.text !== msg.text;
        const isEdited = textChanged ? 1 : (existing.is_edited ? 1 : 0);
        const originalData = (textChanged && !existing.original_data)
          ? existing.data
          : existing.original_data;

        this._db.run(
          `UPDATE messages
           SET data=?, is_edited=?, original_data=?, last_accessed=?, topic_id=?
           WHERE chat_id=? AND id=?`,
          [newData, isEdited, originalData, now, topicId ?? null, chatId, msg.id]
        );
      } else {
        this._db.run(
          `INSERT INTO messages(id, chat_id, topic_id, data, is_deleted, is_edited, cached_at, last_accessed)
           VALUES(?,?,?,?,0,0,?,?)`,
          [msg.id, chatId, topicId ?? null, newData, now, now]
        );
      }
    }
  }

  /**
   * Mark messages that existed in cache but are missing in the fresh Telegram response as deleted.
   * @param {string} chatId
   * @param {number[]} freshIds  – IDs returned by Telegram in this page
   */
  markMissingAsDeleted(chatId, freshIds) {
    if (!freshIds.length) return;
    const placeholders = freshIds.map(() => '?').join(',');
    this._db.run(
      `UPDATE messages SET is_deleted=1
       WHERE chat_id=? AND id NOT IN (${placeholders}) AND is_deleted=0`,
      [chatId, ...freshIds]
    );
  }

  markMessageDeleted(chatId, messageId) {
    this._db.run(
      `UPDATE messages SET is_deleted=1 WHERE chat_id=? AND id=?`,
      [chatId, messageId]
    );
  }

  getOriginalMessage(chatId, messageId) {
    const row = this._db.get(
      `SELECT original_data FROM messages WHERE chat_id=? AND id=?`,
      [chatId, messageId]
    );
    if (!row || !row.original_data) return null;
    try { return JSON.parse(row.original_data); } catch { return null; }
  }

  // ── Media files ──────────────────────────────────────────────

  _subdirFor(type) {
    if (type === 'thumbnail') return this._thumbnailsDir;
    if (type === 'photo') return this._photosDir;
    if (type === 'video') return this._videosDir;
    return this._cacheDir;
  }

  _extFor(mimeType) {
    if (!mimeType) return '.bin';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
    if (mimeType.includes('png')) return '.png';
    if (mimeType.includes('webm')) return '.webm';
    if (mimeType.includes('quicktime')) return '.mov';
    if (mimeType.includes('mp4') || mimeType.startsWith('video/')) return '.mp4';
    if (mimeType.startsWith('image/')) return '.jpg';
    return '.bin';
  }

  /**
   * Save a media buffer to disk and record it in the DB.
   * @returns {string} the saved file path
   */
  cacheMediaFile(chatId, messageId, type, buffer, mimeType) {
    const subdir = this._subdirFor(type);
    const ext = this._extFor(mimeType);
    const safeChat = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeChat}_${messageId}_${Date.now()}${ext}`;
    const filePath = path.join(subdir, fileName);

    fs.writeFileSync(filePath, buffer);
    const fileSize = buffer.length;
    const now = Date.now();

    this._db.run(
      `INSERT OR REPLACE INTO media_files(chat_id, message_id, media_type, file_path, file_size, mime_type, cached_at, last_accessed)
       VALUES(?,?,?,?,?,?,?,?)`,
      [chatId, messageId, type, filePath, fileSize, mimeType ?? null, now, now]
    );

    this._evictIfNeeded();
    return filePath;
  }

  /**
   * Get cached media file info. Returns null if not cached or file missing.
   */
  getCachedMedia(chatId, messageId, type) {
    const row = this._db.get(
      `SELECT file_path, mime_type FROM media_files
       WHERE chat_id=? AND message_id=? AND media_type=?`,
      [chatId, messageId, type]
    );
    if (!row) return null;
    if (!fs.existsSync(row.file_path)) {
      // Stale entry — remove it
      this._db.run(
        `DELETE FROM media_files WHERE chat_id=? AND message_id=? AND media_type=?`,
        [chatId, messageId, type]
      );
      return null;
    }
    // Touch last_accessed
    this._db.run(
      `UPDATE media_files SET last_accessed=? WHERE chat_id=? AND message_id=? AND media_type=?`,
      [Date.now(), chatId, messageId, type]
    );
    return { filePath: row.file_path, mimeType: row.mime_type };
  }

  // ── Avatars ──────────────────────────────────────────────────

  cacheAvatar(chatId, buffer) {
    const safeChat = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const existing = this._db.get(`SELECT file_path FROM avatars WHERE chat_id=?`, [chatId]);

    // Remove old file if it exists
    if (existing?.file_path && fs.existsSync(existing.file_path)) {
      try { fs.unlinkSync(existing.file_path); } catch (_) {}
    }

    const fileName = `${safeChat}_${Date.now()}.jpg`;
    const filePath = path.join(this._avatarsDir, fileName);
    fs.writeFileSync(filePath, buffer);
    const now = Date.now();

    this._db.run(
      `INSERT OR REPLACE INTO avatars(chat_id, file_path, file_size, cached_at, last_accessed)
       VALUES(?,?,?,?,?)`,
      [chatId, filePath, buffer.length, now, now]
    );

    this._evictIfNeeded();
    return filePath;
  }

  getCachedAvatar(chatId) {
    const row = this._db.get(
      `SELECT file_path, cached_at FROM avatars WHERE chat_id=?`,
      [chatId]
    );
    if (!row) return null;
    if (!fs.existsSync(row.file_path)) {
      this._db.run(`DELETE FROM avatars WHERE chat_id=?`, [chatId]);
      return null;
    }

    const refreshHours = parseInt(this.getSetting('avatar_refresh_hours') ?? '24', 10);
    const needsRefresh = (Date.now() - row.cached_at) > refreshHours * 3600 * 1000;

    this._db.run(`UPDATE avatars SET last_accessed=? WHERE chat_id=?`, [Date.now(), chatId]);
    return { filePath: row.file_path, needsRefresh };
  }

  // ── Stats & Management ───────────────────────────────────────

  getCacheStats() {
    const mediaSize = this._db.get(`SELECT COALESCE(SUM(file_size),0) as s FROM media_files`)?.s ?? 0;
    const avatarSize = this._db.get(`SELECT COALESCE(SUM(file_size),0) as s FROM avatars`)?.s ?? 0;
    const messageCount = this._db.get(`SELECT COUNT(*) as c FROM messages`)?.c ?? 0;
    const mediaCount = this._db.get(`SELECT COUNT(*) as c FROM media_files`)?.c ?? 0;
    const avatarCount = this._db.get(`SELECT COUNT(*) as c FROM avatars`)?.c ?? 0;

    // Estimate DB file size
    let dbSize = 0;
    const dbPath = path.join(this._cacheDir, 'cache.db');
    try { dbSize = fs.statSync(dbPath).size; } catch (_) {}

    return {
      totalSize: mediaSize + avatarSize + dbSize,
      messageCount,
      mediaCount,
      avatarCount,
    };
  }

  clearAllCache() {
    // Delete all media files
    const mediaRows = this._db.all(`SELECT file_path FROM media_files`);
    for (const row of mediaRows) {
      try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch (_) {}
    }
    const avatarRows = this._db.all(`SELECT file_path FROM avatars`);
    for (const row of avatarRows) {
      try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch (_) {}
    }

    this._db.exec(`
      DELETE FROM messages;
      DELETE FROM media_files;
      DELETE FROM avatars;
    `);
  }

  // ── LRU Eviction ─────────────────────────────────────────────

  _evictIfNeeded() {
    const maxSize = parseInt(this.getSetting('max_cache_size') ?? '0', 10);
    if (maxSize === 0) return; // unlimited

    const stats = this.getCacheStats();
    if (stats.totalSize <= maxSize) return;

    // Evict oldest media files until under limit
    const candidates = this._db.all(
      `SELECT id, file_path, file_size FROM media_files ORDER BY last_accessed ASC`
    );

    let currentSize = stats.totalSize;
    for (const row of candidates) {
      if (currentSize <= maxSize) break;
      try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch (_) {}
      this._db.run(`DELETE FROM media_files WHERE id=?`, [row.id]);
      currentSize -= row.file_size;
    }
  }
}
