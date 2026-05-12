const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendCode: (phoneNumber) => ipcRenderer.invoke('telegram:send-code', phoneNumber),
  signIn: (data) => ipcRenderer.invoke('telegram:sign-in', data),
  checkAuth: () => ipcRenderer.invoke('telegram:check-auth'),
  getDialogs: () => ipcRenderer.invoke('telegram:get-dialogs'),
  getForumTopics: (chatId) => ipcRenderer.invoke('telegram:get-forum-topics', chatId),
  getAvatar: (chatId) => ipcRenderer.invoke('telegram:get-avatar', chatId),
  resolveLink: (url) => ipcRenderer.invoke('telegram:resolve-link', url),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  onDeepLink: (callback) => {
    ipcRenderer.on('deep-link', (_event, url) => callback(url));
  },
  getMessages: (data) => ipcRenderer.invoke('telegram:get-messages', data),
  getMessageMedia: (data) => ipcRenderer.invoke('telegram:get-message-media', data),
  getMessageMediaFile: (data) => ipcRenderer.invoke('telegram:get-message-media-file', data),
  getMessageMediaStream: (data) => ipcRenderer.invoke('telegram:get-message-media-stream', data),
  saveMessageMediaFile: (data) => ipcRenderer.invoke('telegram:save-message-media-file', data),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  startDownload: (data) => ipcRenderer.invoke('telegram:start-download', data),
  stopDownload: () => ipcRenderer.invoke('telegram:stop-download'),
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download:progress', (_event, value) => callback(value));
  },
  onMediaProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('media:progress', listener);
    return () => ipcRenderer.removeListener('media:progress', listener);
  },
  selectFile: () => ipcRenderer.invoke('dialog:select-file'),
  sendMessage: (data) => ipcRenderer.invoke('telegram:send-message', data),
  sendMedia: (data) => ipcRenderer.invoke('telegram:send-media', data),
  createTopic: (data) => ipcRenderer.invoke('telegram:create-topic', data),
  sendReaction: (data) => ipcRenderer.invoke('telegram:send-reaction', data),
  onSendProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('send:progress', listener);
    return () => ipcRenderer.removeListener('send:progress', listener);
  },
  readHistory: (chatId) => ipcRenderer.invoke('telegram:read-history', chatId),
  getCacheStats: () => ipcRenderer.invoke('cache:get-stats'),
  clearCache: () => ipcRenderer.invoke('cache:clear-all'),
  getCacheSettings: () => ipcRenderer.invoke('cache:get-settings'),
  setCacheSettings: (data) => ipcRenderer.invoke('cache:set-settings', data),
  getOriginalMessage: (data) => ipcRenderer.invoke('cache:get-original-message', data),
  getFullChat: (chatId) => ipcRenderer.invoke('telegram:get-full-chat', chatId),
  getSharedMedia: (data) => ipcRenderer.invoke('telegram:get-shared-media', data),
});
