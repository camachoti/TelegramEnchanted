import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { TelegramClient, Api, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import { CacheManager } from './cache.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;
let client;
let mediaStreamServer;
let mediaStreamBaseUrl = '';
let activeDownloadAborted = false;
let cache;

// Load existing session if available
const SESSION_FILE = path.join(app.getPath('userData'), 'telegram_session.txt');
const MEDIA_STREAM_DIR = path.join(app.getPath('userData'), 'stream_cache');
let sessionString = "";
if (fs.existsSync(SESSION_FILE)) {
  sessionString = fs.readFileSync(SESSION_FILE, 'utf8');
}
let session = new StringSession(sessionString);

// Setup required variables, replace these with actual env variables
const apiId = parseInt(process.env.API_ID || "0");
const apiHash = process.env.API_HASH || "";

function getFirstFetchedMessage(result) {
  if (!result) return null;
  if (Array.isArray(result)) return result[0] || null;
  return result;
}

function ensureMediaStreamDir() {
  if (!fs.existsSync(MEDIA_STREAM_DIR)) {
    fs.mkdirSync(MEDIA_STREAM_DIR, { recursive: true });
  }
}

function sanitizeForFilename(value) {
  return String(value).replace(/[^\w-]/g, '_');
}

function getMediaFileExtension(message) {
  if (message.file?.ext) {
    return message.file.ext.startsWith('.') ? message.file.ext : `.${message.file.ext}`;
  }

  const mimeType = message.document?.mimeType || '';
  if (mimeType === 'video/webm') return '.webm';
  if (mimeType === 'video/quicktime') return '.mov';
  if (mimeType.startsWith('video/')) return '.mp4';
  if (mimeType.startsWith('image/')) return '.jpg';
  return '.bin';
}

function getMediaFilename(message) {
  if (message?.file?.name) {
    return path.basename(message.file.name);
  }

  return `media_${message?.id || 'file'}${getMediaFileExtension(message)}`;
}

function getMessageDownloadFilename(message) {
  let ext = '.bin';
  if (message.photo) ext = '.jpg';
  else if (message.video) ext = '.mp4';
  else if (message.file?.ext) ext = message.file.ext;
  else if (message.document?.mimeType) {
    const mimeParts = message.document.mimeType.split('/');
    if (mimeParts.length === 2) {
      ext = `.${mimeParts[1]}`;
    }
  }

  let name = `media_${message.id}${ext}`;
  if (message.file?.name) {
    name = message.file.name;
  }

  return name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
}

function isDownloadableMedia(message) {
  if (message.photo || message.video) return true;

  const mime = message.document?.mimeType || '';
  return mime.startsWith('video/') || mime.startsWith('image/') || mime.startsWith('audio/');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const mediaStreams = new Map();

function toNumberValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value.toJSNumber === 'function') return value.toJSNumber();
  if (value && typeof value.toString === 'function') return Number(value.toString());
  return 0;
}

function emitMediaProgress(chatId, messageId, downloaded, total, stage) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const downloadedNumber = toNumberValue(downloaded);
  const totalNumber = toNumberValue(total);
  const progress = totalNumber > 0 ? Math.min(100, Math.round((downloadedNumber / totalNumber) * 100)) : 0;

  mainWindow.webContents.send('media:progress', {
    chatId: String(chatId),
    messageId,
    downloaded: downloadedNumber,
    total: totalNumber,
    progress,
    stage
  });
}

async function downloadPreviewMedia(message, isPlayableVideo) {
  const thumbSizes = [1, 0];

  for (const thumb of thumbSizes) {
    try {
      const buffer = await client.downloadMedia(message, {
        thumb,
        workers: 1
      });

      if (buffer && buffer.length > 0) {
        return buffer;
      }
    } catch (_error) {
      // Ignore thumb fallback errors and try the next candidate.
    }
  }

  return client.downloadMedia(message, { workers: 1 });
}

const streamEventTargets = new Map();

function notifyStreamListeners(streamKey) {
  const targets = streamEventTargets.get(streamKey);
  if (targets) {
    for (const target of targets) {
      target.notify();
    }
  }
}

class StreamByteNotifier {
  constructor() {
    this._resolve = null;
    this._promise = new Promise(r => { this._resolve = r; });
  }
  notify() {
    if (this._resolve) {
      this._resolve();
      this._resolve = null;
    }
  }
  wait() {
    return this._promise;
  }
}

async function waitForReadableBytes(streamState, startByte, timeoutMs = 30000) {
  const startedAt = Date.now();
  const streamKey = streamState.streamKey;

  while (Date.now() - startedAt < timeoutMs) {
    const size = fs.existsSync(streamState.filePath) ? fs.statSync(streamState.filePath).size : 0;
    if (size > startByte) {
      return size;
    }

    if (streamState.completed || streamState.error) {
      return size;
    }

    const notifier = new StreamByteNotifier();
    if (!streamEventTargets.has(streamKey)) {
      streamEventTargets.set(streamKey, []);
    }
    streamEventTargets.get(streamKey).push(notifier);

    const raceResult = await Promise.race([
      notifier.wait(),
      new Promise(resolve => setTimeout(resolve, 500))
    ]);

    const idx = streamEventTargets.get(streamKey)?.indexOf(notifier);
    if (idx !== undefined && idx >= 0) {
      streamEventTargets.get(streamKey).splice(idx, 1);
    }

    const currentSize = fs.existsSync(streamState.filePath) ? fs.statSync(streamState.filePath).size : 0;
    if (currentSize > startByte) {
      return currentSize;
    }
  }

  return fs.existsSync(streamState.filePath) ? fs.statSync(streamState.filePath).size : 0;
}

async function ensureVideoStream(chatId, messageId) {
  ensureMediaStreamDir();

  const streamKey = `${chatId}:${messageId}`;
  const existingStream = mediaStreams.get(streamKey);
  if (existingStream && !existingStream.error) {
    existingStream.lastAccessAt = Date.now();
    return existingStream;
  }

  if (existingStream?.error) {
    mediaStreams.delete(streamKey);
    if (fs.existsSync(existingStream.filePath)) {
      try { fs.unlinkSync(existingStream.filePath); } catch (_) {}
    }
  }

  const entity = await client.getEntity(chatId);
  const result = await client.getMessages(entity, { ids: [messageId] });
  const message = getFirstFetchedMessage(result);

  if (!message?.media) {
    throw new Error('No media found for stream');
  }

  const mimeType = message.document?.mimeType || 'video/mp4';
  const totalBytes = Number(message.document?.size || 0);
  const token = crypto.randomUUID();
  const filePath = path.join(
    MEDIA_STREAM_DIR,
    `${sanitizeForFilename(chatId)}_${messageId}_${token}${getMediaFileExtension(message)}`
  );

  const fd = fs.openSync(filePath, 'w');
  if (totalBytes > 0) {
    fs.ftruncateSync(fd, totalBytes);
  }
  fs.closeSync(fd);

  const streamState = {
    token,
    filePath,
    mimeType,
    totalBytes,
    completed: false,
    error: null,
    lastAccessAt: Date.now(),
    streamKey
  };

  mediaStreams.set(streamKey, streamState);

  client.downloadMedia(message, {
    outputFile: filePath,
    progressCallback: (downloaded, total) => {
      streamState.lastAccessAt = Date.now();
      emitMediaProgress(chatId, messageId, downloaded, total, 'streaming');
      notifyStreamListeners(streamKey);
    }
  }).then(() => {
    streamState.completed = true;
    emitMediaProgress(chatId, messageId, streamState.totalBytes || 1, streamState.totalBytes || 1, 'streaming');
    notifyStreamListeners(streamKey);
  }).catch(error => {
    streamState.error = error;
    console.error('Error streaming video media:', error);
    notifyStreamListeners(streamKey);
  });

  return streamState;
}

async function handleMediaStreamRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const token = url.pathname.replace('/media/', '');
  const streamState = [...mediaStreams.values()].find(item => item.token === token);

  if (!streamState) {
    res.writeHead(404);
    res.end('Stream not found');
    return;
  }

  streamState.lastAccessAt = Date.now();

  const rangeHeader = req.headers.range;
  let start = 0;
  let requestedEnd = null;

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      start = Number(match[1]);
      if (match[2]) {
        requestedEnd = Number(match[2]);
      }
    }
  }

  const requestedStart = start;
  const currentSize = await waitForReadableBytes(streamState, requestedStart);

  if (currentSize <= requestedStart && streamState.completed) {
    const totalSize = streamState.totalBytes || currentSize;
    if (requestedStart >= totalSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${totalSize}`
      });
      res.end();
      return;
    }
  }

  if (currentSize <= requestedStart && !streamState.completed) {
    res.writeHead(425);
    res.end();
    return;
  }

  const maxChunkSize = 4 * 1024 * 1024;
  const end = Math.min(
    requestedEnd ?? (requestedStart + maxChunkSize - 1),
    currentSize - 1
  );

  const contentLength = end - requestedStart + 1;
  const totalSize = streamState.totalBytes || Math.max(currentSize, end + 1);

  if (rangeHeader) {
    res.writeHead(206, {
      'Content-Type': streamState.mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Content-Range': `bytes ${requestedStart}-${end}/${totalSize}`,
      'Cache-Control': 'no-store'
    });
  } else {
    res.writeHead(200, {
      'Content-Type': streamState.mimeType,
      'Accept-Ranges': 'bytes',
      'Content-Length': contentLength,
      'Cache-Control': 'no-store'
    });
  }

  fs.createReadStream(streamState.filePath, { start: requestedStart, end }).pipe(res);
}

async function startMediaStreamServer() {
  if (mediaStreamServer) return;

  ensureMediaStreamDir();

  const existingFiles = fs.readdirSync(MEDIA_STREAM_DIR);
  for (const file of existingFiles) {
    try { fs.unlinkSync(path.join(MEDIA_STREAM_DIR, file)); } catch (_) {}
  }

  mediaStreamServer = http.createServer((req, res) => {
    handleMediaStreamRequest(req, res).catch(error => {
      console.error('Media stream server error:', error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end('Stream error');
    });
  });

  await new Promise(resolve => {
    mediaStreamServer.listen(0, '127.0.0.1', () => {
      const { port } = mediaStreamServer.address();
      mediaStreamBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, state] of mediaStreams.entries()) {
      if (now - state.lastAccessAt > 30 * 60 * 1000) {
        mediaStreams.delete(key);
        try { fs.unlinkSync(state.filePath); } catch (_) {}
      }
    }
  }, 5 * 60 * 1000);
}

async function getVisibleMessagesPage(entity, limit = 50, offsetId = 0, replyTo = undefined) {
  const visibleMessages = [];
  let nextOffsetId = offsetId;
  let hasMore = true;
  const chunkSize = Math.max(limit, 100);

  while (visibleMessages.length < limit && hasMore) {
    const batch = await client.getMessages(entity, {
      limit: chunkSize,
      offsetId: nextOffsetId || undefined,
      replyTo
    });

    const messagesBatch = Array.isArray(batch) ? batch : batch ? [batch] : [];

    if (messagesBatch.length === 0) {
      hasMore = false;
      break;
    }

    const batchVisibleMessages = messagesBatch.filter(message => !message?.action);
    visibleMessages.push(...batchVisibleMessages);
    nextOffsetId = messagesBatch[messagesBatch.length - 1]?.id || nextOffsetId;

    if (messagesBatch.length < chunkSize) {
      hasMore = false;
    }
  }

  const slicedMessages = visibleMessages.slice(0, limit);

  return {
    messages: slicedMessages,
    hasMore: hasMore || visibleMessages.length > limit,
    oldestMessageId: slicedMessages[slicedMessages.length - 1]?.id ?? null
  };
}

const RESOURCES_PATH = isDev
  ? path.join(__dirname, '../../build')
  : process.resourcesPath;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    icon: path.join(RESOURCES_PATH, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(www\.)/, '');
    if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
      mainWindow.webContents.send('deep-link', url);
    } else if (url.startsWith('tg://')) {
      mainWindow.webContents.send('deep-link', url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevServer = isDev && url.startsWith(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
    const isLocalFile = url.startsWith('file://');
    if (!isDevServer && !isLocalFile) {
      event.preventDefault();
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase().replace(/^(www\.)/, '');
      if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
        mainWindow.webContents.send('deep-link', url);
      } else if (url.startsWith('tg://')) {
        mainWindow.webContents.send('deep-link', url);
      } else {
        shell.openExternal(url);
      }
    }
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }
}

const PROTOCOL = 'tg';
app.setAsDefaultProtocolClient(PROTOCOL);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.find(arg => arg.startsWith('tg://') || arg.includes('t.me/') || arg.includes('telegram.me/'));
    if (url && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('deep-link', url);
    }
  });

  app.whenReady().then(async () => {
    cache = new CacheManager(app.getPath('userData'));
    await startMediaStreamServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('open-url', (_event, url) => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('deep-link', url);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (mediaStreamServer) {
      mediaStreamServer.close();
    }
    if (cache) cache.close();
    app.quit();
  }
});

// IPC Communication for Telegram Auth
ipcMain.handle('telegram:send-code', async (event, phoneNumber) => {
  try {
    if(!apiId || !apiHash) {
        throw new Error("API_ID and API_HASH are required in .env");
    }
    
    client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    });
    
    await client.connect();
    const result = await client.sendCode(
      { apiId, apiHash },
      phoneNumber
    );
    return { success: true, phoneCodeHash: result.phoneCodeHash };
  } catch (error) {
    console.error("Error sending code:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:sign-in', async (event, { phoneNumber, phoneCodeHash, phoneCode }) => {
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber,
      phoneCodeHash,
      phoneCode,
    }));
    
    // Save session to disk so we remember the user
    const savedSessionString = client.session.save();
    fs.writeFileSync(SESSION_FILE, savedSessionString, 'utf8');
    console.log("Session saved to disk.");
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Check if logged in using the saved session
ipcMain.handle('telegram:check-auth', async () => {
    try {
      if (!apiId || !apiHash) return { isAuthorized: false };
      
      if (sessionString) {
        client = new TelegramClient(session, apiId, apiHash, {
          connectionRetries: 5,
        });
        await client.connect();
        
        const isAuth = await client.checkAuthorization();
        return { isAuthorized: isAuth };
      }
      return { isAuthorized: false };
    } catch (e) {
      console.error("Auth check failed:", e);
      return { isAuthorized: false };
    }
});

ipcMain.handle('telegram:resolve-link', async (event, url) => {
  try {
    let resolvedUrl = url;
    if (url.startsWith('tg://')) {
      try {
        const parsed = new URL(url);
        if (parsed.hostname === 'resolve' && parsed.searchParams.has('domain')) {
          resolvedUrl = `https://t.me/${parsed.searchParams.get('domain')}`;
        } else if (parsed.hostname === 'resolve' && parsed.searchParams.has('phone')) {
          return { success: false, error: 'Unsupported link type' };
        } else {
          return { success: false, error: 'Unsupported tg:// link type' };
        }
      } catch (_) {
        return { success: false, error: 'Invalid tg:// link' };
      }
    }

    let username = null;

    try {
      const parsed = new URL(resolvedUrl);
      const host = parsed.hostname.toLowerCase().replace(/^(www\.)?/, '');
      if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
        username = parsed.pathname.split('/').filter(Boolean)[0] || null;
      }
    } catch (_) {}

    if (!username) {
      const match = resolvedUrl.match(/(?:t\.me|telegram\.me|telegram\.dog)\/([a-zA-Z0-9_]{5,32})/);
      if (match) username = match[1];
    }

    if (!username || username.startsWith('+') || username === 'c') {
      return { success: false, error: 'Unsupported link type' };
    }

    const entity = await client.getEntity(username);
    const entityId = entity.id?.toString();

    const dialogs = await client.getDialogs();
    const found = dialogs.find(d => d.id?.toString() === entityId);

    return {
      success: true,
      chat: found ? {
        id: found.id.toString(),
        title: found.title,
        isGroup: found.isGroup,
        isChannel: found.isChannel,
        hasTopics: Boolean(found.entity?.forum),
        isMember: true
      } : {
        id: entityId,
        title: entity.title || entity.firstName || username,
        isGroup: !!(entity.megagroup || entity.left || entity.gigagroup || entity.className === 'Channel' || entity.className === 'Chat'),
        isChannel: !!(entity.broadcast),
        hasTopics: false,
        isMember: false
      }
    };
  } catch (error) {
    console.error('Error resolving Telegram link:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('openExternal', async (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('telegram:get-dialogs', async () => {
  try {
    const dialogs = await client.getDialogs();
    return {
      success: true,
      dialogs: dialogs.map(d => ({
        id: d.id.toString(),
        title: d.title,
        isGroup: d.isGroup,
        isChannel: d.isChannel,
        hasTopics: Boolean(d.entity?.forum),
        lastMessageText: (() => {
          const msg = d.message;
          if (!msg) return '';
          if (msg.message) return msg.message;
          if (msg.media) return '📎 Mídia';
          if (msg.action) return '🔔 Notificação';
          return '';
        })(),
        lastMessageDate: d.message?.date || 0,
        unreadCount: d.unreadCount || 0,
      }))
    };
  } catch (error) {
    console.error("Error getting dialogs:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:get-forum-topics', async (event, chatId) => {
  try {
    const entity = await client.getEntity(chatId);

    if (!entity?.forum) {
      return { success: true, topics: [] };
    }

    const channel = utils.getInputChannel(await client.getInputEntity(chatId));
    const topics = [];
    let offsetDate = 0;
    let offsetId = 0;
    let offsetTopic = 0;
    const limit = 100;

    while (topics.length < 500) {
      const result = await client.invoke(new Api.channels.GetForumTopics({
        channel,
        offsetDate,
        offsetId,
        offsetTopic,
        limit
      }));

      const batch = (result.topics || []).filter(topic => topic.className === 'ForumTopic' && !topic.hidden);
      topics.push(...batch.map(topic => ({
        id: topic.id,
        title: topic.title,
        topMessageId: topic.topMessage,
        unreadCount: topic.unreadCount || 0,
        closed: Boolean(topic.closed),
        pinned: Boolean(topic.pinned)
      })));

      if (!result.topics || result.topics.length < limit) {
        break;
      }

      const lastTopic = batch[batch.length - 1];
      if (!lastTopic) {
        break;
      }

      offsetDate = lastTopic.date || 0;
      offsetId = lastTopic.topMessage || 0;
      offsetTopic = lastTopic.id || 0;
    }

    return { success: true, topics };
  } catch (error) {
    console.error("Error getting forum topics:", error);
    return { success: false, error: error.message };
  }
});

// Get chat avatar — cache-first with background refresh
ipcMain.handle('telegram:get-avatar', async (event, chatId) => {
  try {
    // Try cache first
    if (cache) {
      const cached = cache.getCachedAvatar(chatId);
      if (cached) {
        const base64 = fs.readFileSync(cached.filePath).toString('base64');
        if (cached.needsRefresh) {
          // Return cached immediately, refresh in background
          client.getEntity(chatId)
            .then(entity => client.downloadProfilePhoto(entity, { isBig: false }))
            .then(buffer => { if (buffer?.length) cache.cacheAvatar(chatId, buffer); })
            .catch(() => {});
        }
        return { success: true, base64 };
      }
    }

    const entity = await client.getEntity(chatId);
    const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
    if (buffer && buffer.length > 0) {
      if (cache) cache.cacheAvatar(chatId, buffer);
      return { success: true, base64: buffer.toString('base64') };
    }
    return { success: false };
  } catch (error) {
    return { success: false };
  }
});

// Get chat messages (for preview) — cache after fetch, enrich with delete/edit flags
ipcMain.handle('telegram:get-messages', async (event, { chatId, limit = 50, offsetId = 0, topicId }) => {
  try {
    const entity = await client.getEntity(chatId);
    const replyTo = topicId ? topicId : undefined;
    const { messages, hasMore, oldestMessageId } = await getVisibleMessagesPage(entity, limit, offsetId, replyTo);

    const mapped = messages.map(m => {
      let mediaSize = null;
      if (m.document && m.document.size) {
          mediaSize = Number(m.document.size);
      } else if (m.photo && m.photo.sizes && m.photo.sizes.length > 0) {
          const biggest = m.photo.sizes[m.photo.sizes.length - 1];
          if (biggest && biggest.size) mediaSize = Number(biggest.size);
      }

      return {
        id: m.id,
        text: m.message || '',
        hasMedia: !!m.media,
        isPhoto: !!m.photo,
        isVideo: !!m.video || (m.document && m.document.mimeType && m.document.mimeType.startsWith('video/')),
        mediaSize,
        date: m.date,
        out: m.out,
        senderId: m.senderId ? m.senderId.toString() : null,
        senderName: (() => {
          if (m.out) return null;
          const s = m.sender;
          if (!s) return null;
          if (s.firstName || s.lastName) return [s.firstName, s.lastName].filter(Boolean).join(' ').trim();
          return s.title || s.username || null;
        })(),
        reactions: (m.reactions?.results || [])
          .filter(r => r.reaction?.emoticon)
          .map(r => ({
            emoji: r.reaction.emoticon,
            count: r.count,
            mine: r.chosenOrder !== undefined && r.chosenOrder !== null,
          })),
      };
    });

    // Persist to cache and enrich with is_deleted / is_edited
    if (cache) {
      cache.cacheMessages(chatId, topicId ?? null, mapped);
      const freshIds = mapped.map(m => m.id);
      if (offsetId === 0 && freshIds.length > 0) {
        cache.markMissingAsDeleted(chatId, freshIds);
      }
    }

    // Enrich renderer objects with cache flags
    const enriched = mapped.map(m => {
      if (!cache) return m;
      const row = cache['_db'].get(
        `SELECT is_deleted, is_edited FROM messages WHERE chat_id=? AND id=?`,
        [chatId, m.id]
      );
      return { ...m, is_deleted: !!(row?.is_deleted), is_edited: !!(row?.is_edited) };
    });

    return {
      success: true,
      messages: enriched.reverse(),
      hasMore,
      oldestMessageId
    };
  } catch (error) {
    console.error("Error getting messages:", error);
    return { success: false, error: error.message };
  }
});

// Get media thumbnail — cache-first
ipcMain.handle('telegram:get-message-media', async (event, { chatId, messageId }) => {
  try {
    // Check cache first
    if (cache) {
      const cached = cache.getCachedMedia(chatId, messageId, 'thumbnail');
      if (cached) {
        const base64 = fs.readFileSync(cached.filePath).toString('base64');
        return { success: true, base64, mimeType: cached.mimeType || 'image/jpeg' };
      }
    }

    const entity = await client.getEntity(chatId);
    const result = await client.getMessages(entity, { ids: [messageId] });
    const message = getFirstFetchedMessage(result);

    if (message?.media) {
      const mimeType = message.document?.mimeType || (message.photo ? 'image/jpeg' : undefined);
      const isPlayableVideo = !!message.video || !!mimeType?.startsWith('video/');
      const buffer = await downloadPreviewMedia(message, isPlayableVideo);

      if (buffer) {
        if (cache) cache.cacheMediaFile(chatId, messageId, 'thumbnail', buffer, mimeType || 'image/jpeg');
        return { success: true, base64: buffer.toString('base64'), mimeType };
      }
    }
    return { success: false, error: 'No media' };
  } catch (error) {
    console.error("Error downloading media preview:", error);
    return { success: false, error: error.message };
  }
});

// Get full photo — cache-first
ipcMain.handle('telegram:get-message-media-file', async (event, { chatId, messageId }) => {
  try {
    if (cache) {
      const cached = cache.getCachedMedia(chatId, messageId, 'photo');
      if (cached) {
        const base64 = fs.readFileSync(cached.filePath).toString('base64');
        emitMediaProgress(chatId, messageId, 1, 1, 'downloading');
        return { success: true, base64, mimeType: cached.mimeType };
      }
    }

    const entity = await client.getEntity(chatId);
    const result = await client.getMessages(entity, { ids: [messageId] });
    const message = getFirstFetchedMessage(result);

    if (message?.media) {
      const mimeType = message.document?.mimeType || (message.photo ? 'image/jpeg' : 'application/octet-stream');
      const buffer = await client.downloadMedia(message, {
        workers: 1,
        progressCallback: (downloaded, total) => {
          emitMediaProgress(chatId, messageId, downloaded, total, 'downloading');
        }
      });

      if (buffer) {
        if (cache) cache.cacheMediaFile(chatId, messageId, 'photo', buffer, mimeType);
        emitMediaProgress(chatId, messageId, 1, 1, 'downloading');
        return { success: true, base64: buffer.toString('base64'), mimeType };
      }
    }

    return { success: false, error: 'No media file' };
  } catch (error) {
    console.error("Error downloading full media:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:save-message-media-file', async (event, { chatId, messageId }) => {
  try {
    const entity = await client.getEntity(chatId);
    const result = await client.getMessages(entity, { ids: [messageId] });
    const message = getFirstFetchedMessage(result);

    if (!message?.media) {
      return { success: false, error: 'No media file' };
    }

    const defaultPath = path.join(app.getPath('downloads'), getMediaFilename(message));
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, error: 'Canceled' };
    }

    const buffer = await client.downloadMedia(message, {
      workers: 1,
      progressCallback: (downloaded, total) => {
        emitMediaProgress(chatId, messageId, downloaded, total, 'downloading');
      }
    });

    if (!buffer) {
      return { success: false, error: 'No media file' };
    }

    fs.writeFileSync(saveResult.filePath, buffer);
    emitMediaProgress(chatId, messageId, 1, 1, 'downloading');

    return {
      success: true,
      filePath: saveResult.filePath
    };
  } catch (error) {
    console.error('Error saving media file:', error);
    return { success: false, error: error.message };
  }
});

// Video stream — serve from cache if available
ipcMain.handle('telegram:get-message-media-stream', async (event, { chatId, messageId }) => {
  try {
    // Check video cache
    if (cache) {
      const cached = cache.getCachedMedia(chatId, messageId, 'video');
      if (cached) {
        // Serve from cached file via stream server
        const token = crypto.randomUUID();
        const mimeType = cached.mimeType || 'video/mp4';
        const fileSize = fs.statSync(cached.filePath).size;
        const streamKey = `${chatId}:${messageId}`;
        const streamState = {
          token,
          filePath: cached.filePath,
          mimeType,
          totalBytes: fileSize,
          completed: true,
          error: null,
          lastAccessAt: Date.now(),
          streamKey
        };
        mediaStreams.set(streamKey, streamState);
        return { success: true, streamUrl: `${mediaStreamBaseUrl}/media/${token}`, mimeType };
      }
    }

    const streamState = await ensureVideoStream(chatId, messageId);
    // After stream completes, register in cache
    if (cache) {
      const onComplete = () => {
        if (streamState.completed && fs.existsSync(streamState.filePath)) {
          try {
            const buffer = fs.readFileSync(streamState.filePath);
            cache.cacheMediaFile(chatId, messageId, 'video', buffer, streamState.mimeType);
          } catch (_) {}
        }
      };
      if (streamState.completed) {
        onComplete();
      } else {
        // Poll for completion
        const interval = setInterval(() => {
          if (streamState.completed || streamState.error) {
            clearInterval(interval);
            onComplete();
          }
        }, 2000);
      }
    }

    return {
      success: true,
      streamUrl: `${mediaStreamBaseUrl}/media/${streamState.token}`,
      mimeType: streamState.mimeType
    };
  } catch (error) {
    console.error("Error creating media stream:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return { success: false, error: "Canceled" };
  } else {
    return { success: true, folderPath: result.filePaths[0] };
  }
});

// ── Cache management IPC handlers ───────────────────────────────────────────

ipcMain.handle('cache:get-stats', async () => {
  try {
    const stats = cache ? cache.getCacheStats() : { totalSize: 0, messageCount: 0, mediaCount: 0, avatarCount: 0 };
    return { success: true, ...stats };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cache:clear-all', async () => {
  try {
    if (cache) cache.clearAllCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cache:get-settings', async () => {
  try {
    const maxCacheSize = parseInt(cache?.getSetting('max_cache_size') ?? '0', 10);
    const avatarRefreshHours = parseInt(cache?.getSetting('avatar_refresh_hours') ?? '24', 10);
    return { success: true, maxCacheSize, avatarRefreshHours };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cache:set-settings', async (event, { maxCacheSize, avatarRefreshHours }) => {
  try {
    if (cache) {
      if (maxCacheSize !== undefined) cache.setSetting('max_cache_size', String(maxCacheSize));
      if (avatarRefreshHours !== undefined) cache.setSetting('avatar_refresh_hours', String(avatarRefreshHours));
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('cache:get-original-message', async (event, { chatId, messageId }) => {
  try {
    if (!cache) return { success: false, error: 'Cache not initialized' };
    const msg = cache.getOriginalMessage(chatId, messageId);
    if (!msg) return { success: false, error: 'No original message in cache' };
    return { success: true, message: msg };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:stop-download', async () => {
  activeDownloadAborted = true;
  console.log('Mass download: stop requested');
  return { success: true };
});

ipcMain.handle('dialog:select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'webm', 'mp3', 'ogg', 'pdf', 'zip', 'rar'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return { success: false };
  return { success: true, filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
});

ipcMain.handle('telegram:send-message', async (event, { chatId, text, replyToId, topicId }) => {
  try {
    const entity = await client.getEntity(chatId);
    const msg = await client.sendMessage(entity, {
      message: text,
      replyTo: replyToId || undefined,
      topMsgId: topicId || undefined,
    });
    return { success: true, messageId: msg.id };
  } catch (error) {
    console.error('Error sending message:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:send-media', async (event, { chatId, filePath, caption, replyToId, topicId }) => {
  try {
    const entity = await client.getEntity(chatId);
    const msg = await client.sendFile(entity, {
      file: filePath,
      caption: caption || '',
      replyTo: replyToId || undefined,
      topMsgId: topicId || undefined,
      workers: 4,
      progressCallback: (progress) => {
        event.sender.send('send:progress', { progress: Math.round(Number(progress) * 100) });
      }
    });
    return { success: true, messageId: msg.id };
  } catch (error) {
    console.error('Error sending media:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:create-topic', async (event, { chatId, title, iconColor }) => {
  try {
    const channel = utils.getInputChannel(await client.getInputEntity(chatId));
    await client.invoke(new Api.channels.CreateForumTopic({
      channel,
      title,
      iconColor: iconColor || 7322096,
      randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
    }));
    return { success: true };
  } catch (error) {
    console.error('Error creating topic:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:send-reaction', async (event, { chatId, messageId, reaction }) => {
  try {
    const peer = await client.getInputEntity(chatId);
    await client.invoke(new Api.messages.SendReaction({
      peer,
      msgId: messageId,
      reaction: [new Api.ReactionEmoji({ emoticon: reaction })],
    }));
    return { success: true };
  } catch (error) {
    console.error('Error sending reaction:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:read-history', async (event, chatId) => {
  try {
    const entity = await client.getEntity(chatId);
    if (entity.className === 'Channel') {
      await client.invoke(new Api.channels.ReadHistory({
        channel: entity,
        maxId: 0 // 0 means all messages
      }));
    } else {
      await client.invoke(new Api.messages.ReadHistory({
        peer: entity,
        maxId: 0
      }));
    }
    return { success: true };
  } catch (error) {
    console.error('Error reading history:', error);
    return { success: false, error: error.message };
  }
});

// Mass download logic
ipcMain.handle('telegram:start-download', async (event, { chatId, folderPath, topic }) => {
  try {
    console.log('Mass download: started');
    activeDownloadAborted = false;
    const entity = await client.getEntity(chatId);
    const downloadFolder = topic?.title
      ? path.join(folderPath, sanitizeForFilename(topic.title))
      : folderPath;
    let downloadedCount = 0;
    let skippedCount = 0;
    let current = 0;
    let failedCount = 0;

    if (!fs.existsSync(downloadFolder)) {
      fs.mkdirSync(downloadFolder, { recursive: true });
    }

    // Phase 1: Scanning
    event.sender.send('download:progress', { 
      chatId, 
      total: 0, 
      downloaded: 0, 
      currentFile: 'Scanning for media...',
      topicTitle: topic?.title || null,
      isScanning: true
    });

    let totalMedia = 0;
    const scanningIter = client.iterMessages(entity, topic?.id
      ? { limit: undefined, replyTo: topic.id }
      : { limit: undefined });

    for await (const message of scanningIter) {
      if (activeDownloadAborted) break;
      if (isDownloadableMedia(message)) {
        totalMedia++;
        if (totalMedia % 50 === 0) {
          event.sender.send('download:progress', { 
            chatId, 
            total: 0, 
            downloaded: 0, 
            currentFile: `Scanning messages... (${totalMedia} found so far)`,
            topicTitle: topic?.title || null,
            isScanning: true
          });
        }
      }
    }

    if (activeDownloadAborted) {
      return { success: true, aborted: true };
    }

    // Phase 2: Downloading
    const messagesIter = client.iterMessages(entity, topic?.id
      ? { limit: undefined, replyTo: topic.id }
      : { limit: undefined });

    for await (const message of messagesIter) {
      if (activeDownloadAborted) break;

      if (isDownloadableMedia(message)) {
        current++;
        const safeName = getMessageDownloadFilename(message);
        const filePath = path.join(downloadFolder, safeName);
        const partialFilePath = `${filePath}.part`;
        
        if (fs.existsSync(filePath)) {
           skippedCount++;
           if (skippedCount % 10 === 0 || current === totalMedia) {
             event.sender.send('download:progress', { 
               chatId, 
               total: totalMedia, 
               downloaded: downloadedCount + skippedCount, 
               currentFile: `Skipping already downloaded files... (${skippedCount} skipped)`,
               topicTitle: topic?.title || null
             });
           }
           continue;
        }

        if (fs.existsSync(partialFilePath)) {
          fs.unlinkSync(partialFilePath);
        }

        event.sender.send('download:progress', { 
           chatId, 
           total: totalMedia, 
           downloaded: downloadedCount + skippedCount, 
           currentFile: safeName,
           topicTitle: topic?.title || null
        });

        try {
          const downloadedFile = await client.downloadMedia(message, {
            workers: 1,
            outputFile: partialFilePath,
            progressCallback: (downloaded, total) => {
              if (activeDownloadAborted) {
                throw new Error('STOP_ABORTED');
              }

              const downloadedNumber = toNumberValue(downloaded);
              const totalNumber = toNumberValue(total);
              const percent = totalNumber > 0
                ? Math.min(100, Math.round((downloadedNumber / totalNumber) * 100))
                : 0;

              event.sender.send('download:progress', {
                chatId,
                total: totalMedia,
                downloaded: downloadedCount + skippedCount + (percent / 100),
                currentFile: `${safeName} (${percent}%)`,
                topicTitle: topic?.title || null
              });
            }
          });
          
          if (activeDownloadAborted) {
            if (fs.existsSync(partialFilePath)) {
              fs.unlinkSync(partialFilePath);
            }
            break;
          }

          if (downloadedFile || fs.existsSync(partialFilePath)) {
             fs.renameSync(partialFilePath, filePath);
             downloadedCount++;
             
             event.sender.send('download:progress', { 
               chatId, 
               total: totalMedia, 
               downloaded: downloadedCount + skippedCount, 
               currentFile: safeName,
               topicTitle: topic?.title || null
             });
          } else {
            if (fs.existsSync(partialFilePath)) {
              fs.unlinkSync(partialFilePath);
            }
            failedCount++;
            event.sender.send('download:progress', {
              chatId,
              total: totalMedia,
              downloaded: downloadedCount + skippedCount,
              currentFile: `Failed: ${safeName}`,
              topicTitle: topic?.title || null
            });
          }
        } catch (err) {
          if (err.message === 'STOP_ABORTED' || activeDownloadAborted) {
            if (fs.existsSync(partialFilePath)) {
              fs.unlinkSync(partialFilePath);
            }
            break;
          }
          console.error(`Failed to download ${safeName}:`, err);
          if (fs.existsSync(partialFilePath)) {
            fs.unlinkSync(partialFilePath);
          }
          failedCount++;
          event.sender.send('download:progress', {
            chatId,
            total: totalMedia,
            downloaded: downloadedCount + skippedCount,
            currentFile: `Failed: ${safeName}`,
            topicTitle: topic?.title || null
          });
        }
      }
    }

    const finalStatus = activeDownloadAborted 
      ? `Stopped: ${downloadedCount} downloaded, ${skippedCount} skipped`
      : totalMedia === 0
        ? 'No downloadable media found'
        : `Done: ${downloadedCount} downloaded, ${skippedCount} skipped, ${failedCount} failed`;

    event.sender.send('download:progress', {
      chatId,
      total: totalMedia,
      downloaded: downloadedCount + skippedCount,
      currentFile: finalStatus,
      topicTitle: topic?.title || null
    });

    return { success: true, downloadedCount, skippedCount, failedCount, total: totalMedia, aborted: activeDownloadAborted };
  } catch (error) {
    console.error("Download error:", error);
    return { success: false, error: error.message };
  }
});
ipcMain.handle('telegram:get-full-chat', async (event, chatId) => {
  try {
    const entity = await client.getEntity(chatId);
    let fullChat;
    
    if (entity.className === 'Channel' || entity.className === 'Chat') {
      const result = await client.invoke(
        entity.className === 'Channel' 
          ? new Api.channels.GetFullChannel({ channel: entity })
          : new Api.messages.GetFullChat({ chatId: entity.id })
      );
      fullChat = result.fullChat;
    } else {
      const result = await client.invoke(new Api.users.GetFullUser({ id: entity }));
      fullChat = result.fullUser;
    }

    return {
      success: true,
      fullInfo: {
        about: fullChat.about || '',
        participantsCount: fullChat.participantsCount || (entity.participantsCount) || 0,
        username: entity.username || null,
        pinnedMsgId: fullChat.pinnedMsgId || null,
      }
    };
  } catch (error) {
    console.error('Error getting full chat info:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:get-shared-media', async (event, { chatId, limit = 12 }) => {
  try {
    const entity = await client.getEntity(chatId);
    const result = await client.getMessages(entity, {
      filter: new Api.InputMessagesFilterPhotoVideo(),
      limit
    });

    const media = result.map(m => ({
      id: m.id,
      hasMedia: !!m.media,
      isPhoto: !!m.photo,
      isVideo: !!m.video || (m.document && m.document.mimeType?.startsWith('video/')),
      date: m.date,
    }));

    return { success: true, media };
  } catch (error) {
    console.error('Error getting shared media:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:leave-chat', async (event, chatId) => {
  try {
    const entity = await client.getEntity(chatId);
    const inputEntity = await client.getInputEntity(chatId);
    
    console.log('Leaving chat:', entity.className, '| ID:', entity.id?.toString());

    if (entity.className === 'Channel') {
      // Megagrupos e Canais
      await client.invoke(new Api.channels.LeaveChannel({ channel: inputEntity }));
    } else if (entity.className === 'Chat') {
      // Grupos pequenos (legado)
      const me = await client.getMe();
      await client.invoke(new Api.messages.DeleteChatUser({
        chatId: entity.id,
        userId: await client.getInputEntity(me.id),
        revokeHistory: false,
      }));
    } else {
      return { success: false, error: 'Não é possível sair de conversas privadas.' };
    }
    return { success: true };
  } catch (error) {
    console.error('Error leaving chat:', error);
    // Se o erro for que o usuário já não está no grupo, tratamos como sucesso para limpar a UI
    if (error.message.includes('USER_NOT_PARTICIPANT') || error.message.includes('CHAT_ID_INVALID')) {
      return { success: true };
    }
    return { success: false, error: error.message };
  }
});


ipcMain.handle('telegram:mute-chat', async (event, { chatId, muteUntil = 2147483647 }) => {
  try {
    const peer = await client.getInputEntity(chatId);
    await client.invoke(new Api.account.UpdateNotifySettings({
      peer: new Api.InputNotifyPeer({ peer }),
      settings: new Api.InputPeerNotifySettings({
        muteUntil: muteUntil
      })
    }));
    return { success: true };
  } catch (error) {
    console.error('Error muting chat:', error);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('telegram:join-chat', async (event, input) => {
  try {
    // 1. Try to handle as invite link (+hash or joinchat/hash)
    const privateHashMatch = input.match(/\/\+([a-zA-Z0-9_-]+)/) || input.match(/\/joinchat\/([a-zA-Z0-9_-]+)/);
    if (privateHashMatch) {
      await client.invoke(new Api.messages.ImportChatInvite({ hash: privateHashMatch[1] }));
      return { success: true };
    }

    // 2. Try to handle public usernames or IDs
    let username = input;
    if (input.includes('t.me/')) {
      const match = input.match(/t\.me\/([a-zA-Z0-9_]{5,})/);
      if (match) username = match[1];
    }

    const entity = await client.getEntity(username);
    if (entity.className === 'Channel') {
      await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
    } else if (entity.className === 'Chat') {
      await client.invoke(new Api.messages.AddChatUser({
        chatId: entity.id,
        userId: await client.getMe(),
        fwdLimit: 100
      }));
    }
    return { success: true };
  } catch (error) {
    console.error('Error joining chat:', error);
    const msg = error.message || '';
    if (msg.includes('USER_ALREADY_PARTICIPANT') || msg.includes('CHANNELS_ADMIN_PUBLIC_REGEN_FORBIDDEN')) {
      return { success: true, message: 'Você já faz parte deste grupo/canal.' };
    }
    if (msg.includes('INVITE_REQUEST_SENT')) {
      return { success: true, message: 'Solicitação de entrada enviada! Aguarde a aprovação dos administradores.' };
    }
    if (msg.includes('INVITE_HASH_EXPIRED')) {
      return { success: false, error: 'Este link de convite expirou ou é inválido.' };
    }
    return { success: false, error: msg };
  }
});

ipcMain.handle('telegram:check-invite', async (event, url) => {
  try {
    const hashMatch = url.match(/\/\+([a-zA-Z0-9_-]+)/) || url.match(/\/joinchat\/([a-zA-Z0-9_-]+)/) || url.match(/\/invite\/([a-zA-Z0-9_-]+)/);
    if (!hashMatch) return { success: false, error: 'Link de convite inválido.' };
    
    const invite = await client.invoke(new Api.messages.CheckChatInvite({ hash: hashMatch[1] }));
    
    if (invite.className === 'ChatInviteAlready') {
      const chat = invite.chat;
      return {
        success: true,
        alreadyMember: true,
        chat: {
          id: chat.id.toString(),
          title: chat.title,
          isGroup: true,
          isChannel: !!chat.broadcast,
          isMember: true
        }
      };
    }

    return {
      success: true,
      alreadyMember: false,
      chat: {
        id: 'invite_' + hashMatch[1],
        title: invite.title,
        about: invite.about,
        participantsCount: invite.participantsCount,
        isGroup: true,
        isChannel: !!invite.broadcast,
        isMember: false,
        isInvite: true,
        inviteHash: hashMatch[1]
      }
    };
  } catch (error) {
    let errorMessage = error.message;
    if (errorMessage.includes('INVITE_HASH_EXPIRED')) {
      errorMessage = 'Este link de convite expirou ou é inválido.';
    }
    return { success: false, error: errorMessage };
  }
});
