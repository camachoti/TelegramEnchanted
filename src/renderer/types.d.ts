export {};

declare global {
  interface Window {
    electronAPI: {
      sendCode: (phoneNumber: string) => Promise<{ success: boolean; phoneCodeHash?: string; error?: string }>;
      signIn: (data: { phoneNumber: string; phoneCodeHash: string; phoneCode: string }) => Promise<{ success: boolean; error?: string }>;
      checkAuth: () => Promise<{ isAuthorized: boolean }>;
      getDialogs: () => Promise<{ success: boolean; dialogs?: Array<{ id: string; title: string; isGroup: boolean; isChannel: boolean; hasTopics?: boolean }>; error?: string }>;
      getForumTopics: (chatId: string) => Promise<{ success: boolean; topics?: Array<{ id: number; title: string; topMessageId: number; unreadCount: number; closed: boolean; pinned: boolean }>; error?: string }>;
      getAvatar: (chatId: string) => Promise<{ success: boolean; base64?: string }>;
      resolveLink: (url: string) => Promise<{ success: boolean; chat?: { id: string; title: string; isGroup: boolean; isChannel: boolean; hasTopics?: boolean }; error?: string }>;
      openExternal: (url: string) => Promise<void>;
      onDeepLink: (callback: (url: string) => void) => void;
      getMessages: (data: { chatId: string; limit?: number; offsetId?: number; topicId?: number }) => Promise<{ success: boolean; messages?: Array<{ id: number; text: string; date: number; out: boolean; senderId: string | null; hasMedia: boolean; isPhoto: boolean; isVideo: boolean; }>; hasMore?: boolean; oldestMessageId?: number | null; error?: string }>;
      getMessageMedia: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }>;
      getMessageMediaFile: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }>;
      getMessageMediaStream: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; streamUrl?: string; mimeType?: string; error?: string }>;
      saveMessageMediaFile: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      selectFolder: () => Promise<{ success: boolean; folderPath?: string; error?: string }>;
      startDownload: (data: { chatId: string; folderPath: string; topic?: { id: number; title: string; topMessageId: number } | null }) => Promise<{ success: boolean; downloadedCount?: number; skippedCount?: number; failedCount?: number; total?: number; error?: string }>;
      onDownloadProgress: (callback: (data: { chatId: string; total: number; downloaded: number; currentFile: string; topicTitle?: string | null }) => void) => void;
      onMediaProgress: (callback: (data: { chatId: string; messageId: number; downloaded: number; total: number; progress: number; stage: string }) => void) => (() => void);
    };
  }
}
