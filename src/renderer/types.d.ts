export { };

declare global {
  interface Window {
    electronAPI: {
      sendCode: (phoneNumber: string) => Promise<{ success: boolean; phoneCodeHash?: string; error?: string }>;
      signIn: (data: { phoneNumber: string; phoneCodeHash: string; phoneCode: string }) => Promise<{ success: boolean; error?: string }>;
      checkAuth: () => Promise<{ isAuthorized: boolean }>;
      getDialogs: () => Promise<{ success: boolean; dialogs?: Array<{ id: string; title: string; isGroup: boolean; isChannel: boolean; hasTopics?: boolean; lastMessageText?: string; lastMessageDate?: number; unreadCount?: number }>; error?: string }>;
      getChats: (data: { limit?: number; offsetId?: number }) => Promise<{ success: boolean; chats: Array<{ id: string; title: string; isGroup: boolean; isChannel: boolean; isMember?: boolean; hasTopics?: boolean; lastMessageText?: string; lastMessageDate?: number; unreadCount?: number }>; error?: string }>;
      getForumTopics: (chatId: string) => Promise<{ success: boolean; topics?: Array<{ id: number; title: string; topMessageId: number; unreadCount: number; closed: boolean; pinned: boolean }>; error?: string }>;
      getAvatar: (chatId: string) => Promise<{ success: boolean; base64?: string }>;
      resolveLink: (url: string) => Promise<{ success: boolean; chat?: { id: string; title: string; isGroup: boolean; isChannel: boolean; isMember?: boolean; hasTopics?: boolean }; error?: string }>;
      openExternal: (url: string) => Promise<void>;
      onDeepLink: (callback: (url: string) => void) => void;
      getMessages: (data: { chatId: string; limit?: number; offsetId?: number; topicId?: number }) => Promise<{ success: boolean; messages?: Array<{ id: number; text: string; date: number; out: boolean; senderId: string | null; senderName?: string | null; hasMedia: boolean; isPhoto: boolean; isVideo: boolean; reactions?: Array<{ emoji: string; count: number; mine: boolean }>; is_deleted?: boolean; is_edited?: boolean }>; hasMore?: boolean; oldestMessageId?: number | null; error?: string }>;
      getMessageMedia: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }>;
      getMessageMediaFile: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }>;
      getMessageMediaStream: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; streamUrl?: string; mimeType?: string; error?: string }>;
      saveMessageMediaFile: (data: { chatId: string; messageId: number }) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      selectFolder: () => Promise<{ success: boolean; folderPath?: string; error?: string }>;
      startDownload: (data: { chatId: string; folderPath: string; topic?: { id: number; title: string; topMessageId: number } | null }) => Promise<{ success: boolean; downloadedCount?: number; skippedCount?: number; failedCount?: number; total?: number; error?: string }>;
      onDownloadProgress: (callback: (data: { chatId: string; total: number; downloaded: number; currentFile: string; topicTitle?: string | null; isScanning?: boolean }) => void) => void;
      onMediaProgress: (callback: (data: { chatId: string; messageId: number; downloaded: number; total: number; progress: number; stage: string }) => void) => (() => void);
      stopDownload(): Promise<{ success: boolean }>;
      selectFile(): Promise<{ success: boolean; filePath?: string; fileName?: string }>;
      sendMessage(data: { chatId: string; text: string; replyToId?: number; topicId?: number }): Promise<{ success: boolean; messageId?: number; error?: string }>;
      sendMedia(data: { chatId: string; filePath: string; caption?: string; replyToId?: number; topicId?: number }): Promise<{ success: boolean; messageId?: number; error?: string }>;
      createTopic(data: { chatId: string; title: string; iconColor?: number }): Promise<{ success: boolean; error?: string }>;
      sendReaction(data: { chatId: string; messageId: number; reaction: string }): Promise<{ success: boolean; error?: string }>;
      onSendProgress(callback: (data: { progress: number }) => void): () => void;
      readHistory(chatId: string): Promise<{ success: boolean; error?: string }>;
      getCacheStats(): Promise<{ success: boolean; totalSize: number; messageCount: number; mediaCount: number; avatarCount: number }>;
      clearCache(): Promise<{ success: boolean; error?: string }>;
      getCacheSettings(): Promise<{ success: boolean; maxCacheSize: number; avatarRefreshHours: number }>;
      setCacheSettings(data: { maxCacheSize?: number; avatarRefreshHours?: number }): Promise<{ success: boolean; error?: string }>;
      getOriginalMessage(data: { chatId: string; messageId: number }): Promise<{ success: boolean; message?: { id: number; text: string; date: number; out: boolean; senderId: string | null; senderName?: string | null; hasMedia: boolean; isPhoto: boolean; isVideo: boolean }; error?: string }>;
      getFullChat: (chatId: string) => Promise<{ success: boolean; fullInfo?: { about: string; participantsCount: number; username: string | null; pinnedMsgId: number | null }; error?: string }>;
      getSharedMedia: (data: { chatId: string; limit?: number; offsetId?: number }) => Promise<{ success: boolean; media: Array<{ id: number; date: number; hasMedia: boolean; isPhoto: boolean; isVideo: boolean }>; error?: string }>;
      leaveChat: (chatId: string) => Promise<{ success: boolean; error?: string }>;
      muteChat: (data: { chatId: string; muteUntil?: number }) => Promise<{ success: boolean; error?: string }>;
      joinChat: (input: string) => Promise<{ success: boolean; message?: string; error?: string }>;
    };
  }
}
