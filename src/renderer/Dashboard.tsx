import React, { useEffect, useState, useRef } from 'react';
import './Dashboard.css';
import { ChatAvatar } from './ChatAvatar';
import { MessageMedia } from './MessageMedia';

interface Chat {
  id: string;
  title: string;
  isGroup: boolean;
  isChannel: boolean;
  hasTopics?: boolean;
}

interface ForumTopic {
  id: number;
  title: string;
  topMessageId: number;
  unreadCount: number;
  closed: boolean;
  pinned: boolean;
}

interface Message {
  id: number;
  text: string;
  date: number;
  out: boolean;
  senderId: string | null;
  hasMedia: boolean;
  isPhoto: boolean;
  isVideo: boolean;
}

interface DownloadProgress {
  total: number;
  downloaded: number;
  currentFile: string;
  topicTitle?: string | null;
}

export const Dashboard: React.FC = () => {
  const PAGE_SIZE = 50;
  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const shouldScrollToBottomRef = useRef(false);
  const preserveScrollPositionRef = useRef<number | null>(null);
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [forumTopics, setForumTopics] = useState<ForumTopic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState<string>('all');
  
  const [folderPath, setFolderPath] = useState<string>('');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState('');

  const filteredChats = chats.filter(chat =>
    chat.title.toLowerCase().includes(chatSearch.trim().toLowerCase())
  );

  const getChatKind = (chat: Chat) => {
    if (chat.isGroup) return 'grupo';
    if (chat.isChannel) return 'canal';
    return 'conversa privada';
  };

  const formatMessageTime = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const formatMessageDate = (timestamp: number) =>
    new Date(timestamp * 1000).toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });

  const isNewMessageDay = (current: Message, previous?: Message) => {
    if (!previous) return true;

    const currentDate = new Date(current.date * 1000);
    const previousDate = new Date(previous.date * 1000);

    return currentDate.toDateString() !== previousDate.toDateString();
  };

  useEffect(() => {
    fetchDialogs();
    
    window.electronAPI.onDownloadProgress((data) => {
      setProgress({
        total: data.total,
        downloaded: data.downloaded,
        currentFile: data.currentFile,
        topicTitle: data.topicTitle
      });
    });
  }, []);

  useEffect(() => {
    if (selectedChat) {
      shouldScrollToBottomRef.current = true;
      setIsDownloadModalOpen(false);
      setForumTopics([]);
      setSelectedTopicId('all');
      fetchForumTopics(selectedChat);
      loadMessages(selectedChat.id);
    } else {
      setMessages([]);
      setHasMoreMessages(false);
      setOldestMessageId(null);
      setForumTopics([]);
      setSelectedTopicId('all');
    }
  }, [selectedChat]);

  useEffect(() => {
    if (preserveScrollPositionRef.current !== null && chatMessagesRef.current) {
      const previousScrollHeight = preserveScrollPositionRef.current;
      const currentScrollHeight = chatMessagesRef.current.scrollHeight;
      chatMessagesRef.current.scrollTop += currentScrollHeight - previousScrollHeight;
      preserveScrollPositionRef.current = null;
      return;
    }

    if (shouldScrollToBottomRef.current) {
      scrollToBottom();
      shouldScrollToBottomRef.current = false;
    }
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchDialogs = async () => {
    try {
      const res = await window.electronAPI.getDialogs();
      if (res.success && res.dialogs) {
        setChats(res.dialogs);
      } else {
        setError(res.error || 'Failed to fetch chats');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error fetching chats');
    } finally {
      setLoading(false);
    }
  };

  const fetchForumTopics = async (chat: Chat) => {
    if (!chat.hasTopics) return;

    setLoadingTopics(true);
    try {
      const res = await window.electronAPI.getForumTopics(chat.id);
      if (res.success && res.topics) {
        setForumTopics(res.topics);
      } else if (!res.success) {
        setError(res.error || 'Failed to fetch topics');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error fetching topics');
    } finally {
      setLoadingTopics(false);
    }
  };

  const loadMessages = async (chatId: string, offsetId = 0) => {
    setLoadingMessages(true);
    try {
      const res = await window.electronAPI.getMessages({ chatId, limit: PAGE_SIZE, offsetId });
      if (res.success && res.messages) {
        setMessages(res.messages);
        setHasMoreMessages(Boolean(res.hasMore));
        setOldestMessageId(res.oldestMessageId ?? null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMessages(false);
    }
  };

  const loadOlderMessages = async () => {
    if (!selectedChat || !oldestMessageId || loadingMoreMessages) return;

    setLoadingMoreMessages(true);
    if (chatMessagesRef.current) {
      preserveScrollPositionRef.current = chatMessagesRef.current.scrollHeight;
    }

    try {
      const res = await window.electronAPI.getMessages({
        chatId: selectedChat.id,
        limit: PAGE_SIZE,
        offsetId: oldestMessageId
      });

      if (res.success && res.messages?.length) {
        setMessages(current => [...res.messages!, ...current]);
        setHasMoreMessages(Boolean(res.hasMore));
        setOldestMessageId(res.oldestMessageId ?? null);
      } else {
        setHasMoreMessages(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMoreMessages(false);
    }
  };

  const handleSelectFolder = async () => {
    const res = await window.electronAPI.selectFolder();
    if (res.success && res.folderPath) {
      setFolderPath(res.folderPath);
    }
  };

  const handleStartDownload = async () => {
    if (!selectedChat || !folderPath) return;
    const selectedTopic = forumTopics.find(topic => String(topic.id) === selectedTopicId) || null;
    setDownloading(true);
    setProgress(null);
    try {
      const res = await window.electronAPI.startDownload({ 
        chatId: selectedChat.id, 
        folderPath,
        topic: selectedTopic
          ? {
              id: selectedTopic.id,
              title: selectedTopic.title,
              topMessageId: selectedTopic.topMessageId
            }
          : null
      });
      if (!res.success) {
         setError(res.error || 'Failed to start download');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) return (
    <div className="full-screen-loader fade-in">
      <div className="loader-content">
        <div className="spinner large-spinner"></div>
        <p>Summoning your chats...</p>
      </div>
    </div>
  );

  return (
    <div className={`dashboard-container fade-in ${isDarkMode ? 'dark-theme' : ''}`}>
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-header-top">
            <div className="sidebar-title-group">
              <h3>Chats</h3>
              <button
                type="button"
                className={`theme-toggle ${isDarkMode ? 'active' : ''}`}
                onClick={() => setIsDarkMode(current => !current)}
                aria-label={isDarkMode ? 'Desativar modo escuro' : 'Ativar modo escuro'}
                title={isDarkMode ? 'Desativar modo escuro' : 'Ativar modo escuro'}
              >
                {isDarkMode ? (
                  <svg className="theme-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4.75V2.5" />
                    <path d="M17.127 6.873l1.59-1.59" />
                    <path d="M19.25 12h2.25" />
                    <path d="M17.127 17.127l1.59 1.59" />
                    <path d="M12 19.25v2.25" />
                    <path d="M6.873 17.127l-1.59 1.59" />
                    <path d="M4.75 12H2.5" />
                    <path d="M6.873 6.873l-1.59-1.59" />
                    <circle cx="12" cy="12" r="4.25" />
                  </svg>
                ) : (
                  <svg className="theme-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14.5 3.5a8.5 8.5 0 1 0 6 14.5A9.5 9.5 0 0 1 14.5 3.5Z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className={`theme-toggle search-toggle ${isSearchOpen ? 'active' : ''}`}
                onClick={() => {
                  setIsSearchOpen(current => !current);
                  if (isSearchOpen) setChatSearch('');
                }}
                aria-label={isSearchOpen ? 'Fechar pesquisa de chats' : 'Pesquisar chats'}
                title={isSearchOpen ? 'Fechar pesquisa de chats' : 'Pesquisar chats'}
              >
                <span className="search-toggle-icon">⌕</span>
              </button>
            </div>
            <span className="chat-count">{filteredChats.length}</span>
          </div>
          {isSearchOpen && (
            <div className="sidebar-search">
              <input
                type="text"
                value={chatSearch}
                onChange={event => setChatSearch(event.target.value)}
                placeholder="Pesquisar grupos por nome..."
              />
            </div>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="chat-list">
          {filteredChats.map(chat => (
            <div 
              key={chat.id} 
              className={`chat-item ${selectedChat?.id === chat.id ? 'selected' : ''}`}
              onClick={() => setSelectedChat(chat)}
            >
              <div className="chat-avatar">
                 <ChatAvatar chatId={chat.id} title={chat.title} />
              </div>
              <div className="chat-info">
                <div className="chat-title">{chat.title || 'Unknown'}</div>
                <div className="chat-type">{getChatKind(chat)}{chat.hasTopics ? ' · tópicos' : ''}</div>
              </div>
            </div>
          ))}
          {!filteredChats.length && (
            <div className="sidebar-empty-search">Nenhum chat encontrado.</div>
          )}
        </div>
      </div>
      
      <div className="main-panel">
        {/* Persistent Topbar (like original Telegram) */}
        {selectedChat ? (
          <div className="chat-header">
            <div className="chat-header-info">
              <div className="chat-avatar small">
                 <ChatAvatar chatId={selectedChat.id} title={selectedChat.title} />
              </div>
              <div className="chat-header-text">
                <h2>{selectedChat.title}</h2>
                <span>{getChatKind(selectedChat)} · {messages.length} mensagens</span>
              </div>
            </div>
            
            <div className="chat-header-actions">
              <button className="menu-btn" onClick={() => setIsMenuOpen(!isMenuOpen)}>⋮</button>
              {isMenuOpen && (
                <div className="dropdown-menu">
                  <div className="dropdown-item" onClick={() => {
                    setIsDownloadModalOpen(true);
                    setIsMenuOpen(false);
                  }}>
                    <span className="dropdown-icon">🪄</span> Mass Download
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="chat-header empty-header">
             <div className="chat-header-text">
               <h2>Telegram Enchanted</h2>
               <span>Escolha um chat para abrir o histórico</span>
             </div>
          </div>
        )}

        {/* Mass Download Inline Panel */}
        {isDownloadModalOpen && selectedChat && (
          <div className="inline-download-panel slide-down">
            <div className="inline-panel-header">
               <div className="inline-panel-title">
                 <span className="magic-icon">🪄</span>
                 <h3>Enchanted Mass Download</h3>
               </div>
               <button className="close-inline-panel" onClick={() => setIsDownloadModalOpen(false)}>×</button>
            </div>
            
            <div className="inline-panel-body">
              <div className="folder-selection inline-folder">
                <input 
                  type="text" 
                  readOnly 
                  value={folderPath} 
                  placeholder="Select destination folder..." 
                />
                <button className="browse-btn" onClick={handleSelectFolder}>Browse</button>
              </div>

              {selectedChat.hasTopics && (
                <div className="topic-selection">
                  <select
                    value={selectedTopicId}
                    onChange={event => setSelectedTopicId(event.target.value)}
                    disabled={loadingTopics || downloading}
                    aria-label="Selecionar tópico para mass download"
                  >
                    <option value="all">
                      {loadingTopics ? 'Carregando tópicos...' : 'Todos os tópicos'}
                    </option>
                    {forumTopics.map(topic => (
                      <option key={topic.id} value={String(topic.id)}>
                        {topic.pinned ? 'Fixado · ' : ''}{topic.title}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              
              <button 
                className={`magic-btn inline-magic-btn ${downloading ? 'downloading' : ''}`} 
                onClick={handleStartDownload}
                disabled={!folderPath || downloading || loadingTopics}
              >
                {downloading ? (
                  <><span className="spinner small-spinner"></span> Extracting...</>
                ) : 'Start Download'}
              </button>
            </div>

            {progress && (
              <div className="inline-progress-container fade-in">
                <div className="progress-header">
                  <span className="progress-status">
                    {progress.topicTitle ? `${progress.topicTitle} · ${progress.currentFile}` : progress.currentFile}
                  </span>
                  <span className="progress-count">{progress.downloaded} files / {progress.total} scanned</span>
                </div>
                <div className="progress-bar inline-progress">
                  <div 
                    className={`progress-fill ${downloading ? 'animated-stripes' : ''}`} 
                    style={{ width: progress.total > 0 ? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` : '100%' }}
                  ></div>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedChat ? (
          <div className="content-layout slide-up" key={selectedChat.id}>
            
            {/* Chat History */}
            <div className="chat-viewer full-width">
              <div
                ref={chatMessagesRef}
                className="chat-messages"
                onClick={() => isMenuOpen && setIsMenuOpen(false)}
              >
                {loadingMessages ? (
                  <div className="messages-loading">
                    <span className="spinner"></span> Loading history...
                  </div>
                ) : messages.length === 0 ? (
                  <div className="messages-empty">Nenhuma mensagem encontrada.</div>
                ) : (
                  <>
                    {hasMoreMessages && (
                      <div className="messages-load-more">
                        <button
                          type="button"
                          className="load-more-btn"
                          onClick={loadOlderMessages}
                          disabled={loadingMoreMessages}
                        >
                          {loadingMoreMessages ? 'Carregando...' : 'Exibir mais antigas'}
                        </button>
                      </div>
                    )}
                    {messages.map((msg, index) => (
                      <React.Fragment key={msg.id}>
                        {isNewMessageDay(msg, messages[index - 1]) && (
                          <div className="message-date-divider">
                            <span>{formatMessageDate(msg.date)}</span>
                          </div>
                        )}
                        <div className={`message-row ${msg.out ? 'out' : 'in'}`}>
                          <div className={`message-bubble ${msg.out ? 'out' : 'in'} ${msg.hasMedia ? 'has-media' : ''}`}>
                            <div className="message-content">
                              {msg.hasMedia && (
                                <MessageMedia chatId={selectedChat.id} messageId={msg.id} isVideo={msg.isVideo} />
                              )}
                              {msg.text && <div className="message-text">{msg.text}</div>}
                            </div>
                            <div className="message-meta">
                              <div className="message-time">{formatMessageTime(msg.date)}</div>
                            </div>
                          </div>
                        </div>
                      </React.Fragment>
                    ))}
                  </>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state fade-in" style={{height: 'calc(100vh - 55px)'}}>
            <div className="empty-icon">✈</div>
            <h3>Nenhum chat selecionado</h3>
            <p>Escolha um grupo, canal ou conversa na barra lateral para ver o histórico e baixar a mídia.</p>
          </div>
        )}
      </div>
    </div>
  );
};
