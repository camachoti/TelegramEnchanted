import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { TelegramClient, Api, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;
let client;
let mediaStreamServer;
let mediaStreamBaseUrl = '';
let activeDownloadAborted = false;

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
        hasTopics: Boolean(found.entity?.forum)
      } : {
        id: entityId,
        title: entity.title || entity.firstName || username,
        isGroup: !!(entity.megagroup || entity.left || entity.gigagroup || entity.className === 'Channel'),
        isChannel: !!(entity.broadcast),
        hasTopics: false
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

// Get chat avatar
ipcMain.handle('telegram:get-avatar', async (event, chatId) => {
  try {
    const entity = await client.getEntity(chatId);
    const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
    if (buffer && buffer.length > 0) {
      return { success: true, base64: buffer.toString('base64') };
    }
    return { success: false };
  } catch (error) {
    // Expected for deleted accounts or chats without avatars
    return { success: false };
  }
});

// Get chat messages (for preview)
ipcMain.handle('telegram:get-messages', async (event, { chatId, limit = 50, offsetId = 0, topicId }) => {
  try {
    const entity = await client.getEntity(chatId);
    const replyTo = topicId ? topicId : undefined;
    const { messages, hasMore, oldestMessageId } = await getVisibleMessagesPage(entity, limit, offsetId, replyTo);
    
    return {
      success: true,
      messages: messages.map(m => {
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
      }).reverse(),
      hasMore,
      oldestMessageId
    };
  } catch (error) {
    console.error("Error getting messages:", error);
    return { success: false, error: error.message };
  }
});

// Get media thumbnail for chat preview
ipcMain.handle('telegram:get-message-media', async (event, { chatId, messageId }) => {
  try {
    const entity = await client.getEntity(chatId);
    const result = await client.getMessages(entity, { ids: [messageId] });
    const message = getFirstFetchedMessage(result);

    if (message?.media) {
      const mimeType = message.document?.mimeType || (message.photo ? 'image/jpeg' : undefined);
      const isPlayableVideo = !!message.video || !!mimeType?.startsWith('video/');
      const buffer = await downloadPreviewMedia(message, isPlayableVideo);

      if (buffer) {
        return {
          success: true,
          base64: buffer.toString('base64'),
          mimeType
        };
      }
    }
    return { success: false, error: 'No media' };
  } catch (error) {
    console.error("Error downloading media preview:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('telegram:get-message-media-file', async (event, { chatId, messageId }) => {
  try {
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
        emitMediaProgress(chatId, messageId, 1, 1, 'downloading');
        return {
          success: true,
          base64: buffer.toString('base64'),
          mimeType
        };
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

ipcMain.handle('telegram:get-message-media-stream', async (event, { chatId, messageId }) => {
  try {
    const streamState = await ensureVideoStream(chatId, messageId);
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
    // client.readHistory(entity) handles both channels and private chats
    await client.readHistory(entity);
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
