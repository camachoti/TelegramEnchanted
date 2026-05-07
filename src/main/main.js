import { app, BrowserWindow, ipcMain, dialog } from 'electron';
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
  if (!isPlayableVideo) {
    return client.downloadMedia(message, { workers: 1 });
  }

  const thumbCandidates = [1, 0];

  for (const thumb of thumbCandidates) {
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

  return undefined;
}

async function waitForReadableBytes(streamState, startByte, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const size = fs.existsSync(streamState.filePath) ? fs.statSync(streamState.filePath).size : 0;
    if (size > startByte) {
      return size;
    }

    if (streamState.completed || streamState.error) {
      return size;
    }

    await wait(250);
  }

  return fs.existsSync(streamState.filePath) ? fs.statSync(streamState.filePath).size : 0;
}

async function ensureVideoStream(chatId, messageId) {
  ensureMediaStreamDir();

  const streamKey = `${chatId}:${messageId}`;
  const existingStream = mediaStreams.get(streamKey);
  if (existingStream) {
    existingStream.lastAccessAt = Date.now();
    return existingStream;
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

  fs.closeSync(fs.openSync(filePath, 'w'));

  const streamState = {
    token,
    filePath,
    mimeType,
    totalBytes,
    completed: false,
    error: null,
    lastAccessAt: Date.now()
  };

  mediaStreams.set(streamKey, streamState);

  client.downloadMedia(message, {
    outputFile: filePath,
    workers: 1,
    progressCallback: (downloaded, total) => {
      streamState.lastAccessAt = Date.now();
      emitMediaProgress(chatId, messageId, downloaded, total, 'streaming');
    }
  }).then(() => {
    streamState.completed = true;
    emitMediaProgress(chatId, messageId, streamState.totalBytes || 1, streamState.totalBytes || 1, 'streaming');
  }).catch(error => {
    streamState.error = error;
    console.error('Error streaming video media:', error);
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
  const defaultChunkSize = 1024 * 1024;
  let start = 0;
  let requestedEnd = null;

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      start = Number(match[1]);
      requestedEnd = match[2] ? Number(match[2]) : null;
    }
  }

  const currentSize = await waitForReadableBytes(streamState, start);

  if (currentSize <= start && streamState.completed) {
    res.writeHead(416, {
      'Content-Range': `bytes */${streamState.totalBytes || currentSize}`
    });
    res.end();
    return;
  }

  if (currentSize <= start) {
    res.writeHead(425);
    res.end();
    return;
  }

  const end = Math.min(
    requestedEnd ?? start + defaultChunkSize - 1,
    currentSize - 1
  );

  const contentLength = end - start + 1;
  const totalSize = streamState.totalBytes || Math.max(currentSize, end + 1);

  res.writeHead(206, {
    'Content-Type': streamState.mimeType,
    'Accept-Ranges': 'bytes',
    'Content-Length': contentLength,
    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
    'Cache-Control': 'no-store'
  });

  fs.createReadStream(streamState.filePath, { start, end }).pipe(res);
}

async function startMediaStreamServer() {
  if (mediaStreamServer) return;

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
}

async function getVisibleMessagesPage(entity, limit = 50, offsetId = 0) {
  const visibleMessages = [];
  let nextOffsetId = offsetId;
  let hasMore = true;
  const chunkSize = Math.max(limit, 100);

  while (visibleMessages.length < limit && hasMore) {
    const batch = await client.getMessages(entity, {
      limit: chunkSize,
      offsetId: nextOffsetId || undefined
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  await startMediaStreamServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
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
        hasTopics: Boolean(d.entity?.forum)
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
ipcMain.handle('telegram:get-messages', async (event, { chatId, limit = 50, offsetId = 0 }) => {
  try {
    const entity = await client.getEntity(chatId);
    const { messages, hasMore, oldestMessageId } = await getVisibleMessagesPage(entity, limit, offsetId);
    
    return {
      success: true,
      messages: messages.map(m => ({
        id: m.id,
        text: m.message || '',
        hasMedia: !!m.media,
        isPhoto: !!m.photo,
        isVideo: !!m.video || (m.document && m.document.mimeType && m.document.mimeType.startsWith('video/')),
        date: m.date,
        out: m.out,
        senderId: m.senderId ? m.senderId.toString() : null
      })).reverse(),
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

// Mass download logic
ipcMain.handle('telegram:start-download', async (event, { chatId, folderPath, topic }) => {
  try {
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
    
    const messagesIter = client.iterMessages(entity, topic?.id
      ? { limit: undefined, replyTo: topic.id }
      : { limit: undefined });

    for await (const message of messagesIter) {
      if (isDownloadableMedia(message)) {
        current++;
        const safeName = getMessageDownloadFilename(message);
        const filePath = path.join(downloadFolder, safeName);
        
        if (fs.existsSync(filePath)) {
           console.log(`Skipping existing file: ${safeName}`);
           skippedCount++;
           // We only send progress update every 10 skipped files to avoid freezing the UI with thousands of skipped files
           if (skippedCount % 10 === 0) {
             event.sender.send('download:progress', { 
               chatId, 
               total: current, 
               downloaded: downloadedCount + skippedCount, 
               currentFile: `Skipping already downloaded files... (${skippedCount} skipped)`,
               topicTitle: topic?.title || null
             });
           }
           continue;
        }

        event.sender.send('download:progress', { 
           chatId, 
           total: current, 
           downloaded: downloadedCount + skippedCount, 
           currentFile: safeName,
           topicTitle: topic?.title || null
        });

        try {
          const downloadedFile = await client.downloadMedia(message, {
            workers: 1,
            outputFile: filePath,
            progressCallback: (downloaded, total) => {
              const downloadedNumber = toNumberValue(downloaded);
              const totalNumber = toNumberValue(total);
              const percent = totalNumber > 0
                ? Math.min(100, Math.round((downloadedNumber / totalNumber) * 100))
                : 0;

              event.sender.send('download:progress', {
                chatId,
                total: current,
                downloaded: downloadedCount + skippedCount,
                currentFile: `${safeName} (${percent}%)`,
                topicTitle: topic?.title || null
              });
            }
          });
          
          if (downloadedFile || fs.existsSync(filePath)) {
             downloadedCount++;
             
             event.sender.send('download:progress', { 
               chatId, 
               total: current, 
               downloaded: downloadedCount + skippedCount, 
               currentFile: safeName,
               topicTitle: topic?.title || null
             });
          } else {
            failedCount++;
            event.sender.send('download:progress', {
              chatId,
              total: current,
              downloaded: downloadedCount + skippedCount,
              currentFile: `Failed: ${safeName}`,
              topicTitle: topic?.title || null
            });
          }
        } catch (err) {
          console.error(`Failed to download ${safeName}:`, err);
          failedCount++;
          event.sender.send('download:progress', {
            chatId,
            total: current,
            downloaded: downloadedCount + skippedCount,
            currentFile: `Failed: ${safeName}`,
            topicTitle: topic?.title || null
          });
        }
      }
    }

    event.sender.send('download:progress', {
      chatId,
      total: current,
      downloaded: downloadedCount + skippedCount,
      currentFile: current === 0
        ? 'No downloadable media found'
        : `Done: ${downloadedCount} downloaded, ${skippedCount} skipped, ${failedCount} failed`,
      topicTitle: topic?.title || null
    });

    return { success: true, downloadedCount, skippedCount, failedCount, total: current };
  } catch (error) {
    console.error("Download error:", error);
    return { success: false, error: error.message };
  }
});
