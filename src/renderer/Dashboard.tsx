import React, { useEffect, useState, useRef, useCallback } from 'react';
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
  mediaSize?: number | null;
}

interface DownloadProgress {
  total: number;
  downloaded: number;
  currentFile: string;
  topicTitle?: string | null;
  isScanning?: boolean;
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
  const [viewingTopic, setViewingTopic] = useState<ForumTopic | null>(null);
  
  const [folderPath, setFolderPath] = useState<string>('');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [isLightTheme, setIsLightTheme] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [topicSearch, setTopicSearch] = useState('');
  const [isTopicDropdownOpen, setIsTopicDropdownOpen] = useState(false);

  useEffect(() => {
    if (isLightTheme) {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  }, [isLightTheme]);

  const filteredChats = chats.filter(chat =>
    chat.title.toLowerCase().includes(chatSearch.trim().toLowerCase())
  );

  const filteredTopics = forumTopics.filter(topic =>
    topic.title.toLowerCase().includes(topicSearch.trim().toLowerCase())
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

  const URL_REGEX = /(https?:\/\/[^\s<>\u0000-\u001F\u007F\u00A0\u2000-\u200D\u2028\u2029\uFEFF]+)/g;

  const isTelegramLink = (url: string) => {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^(www\.)/, '');
      return host === 't.me' || host === 'telegram.me' || host === 'telegram.dog';
    } catch {
      return false;
    }
  };

  const handleTelegramLinkRef = useRef<((url: string) => void) | null>(null);

  const handleTelegramLink = async (url: string) => {
    try {
      const res = await window.electronAPI.resolveLink(url);
      if (res.success && res.chat) {
        const existing = chats.find(c => c.id === res.chat!.id);
        if (!existing) {
          setChats(prev => [res.chat!, ...prev]);
        }
        setSelectedChat(res.chat!);
      } else {
        window.electronAPI.openExternal(url);
      }
    } catch {
      window.electronAPI.openExternal(url);
    }
  };

  const linkifyText = (text: string) => {
    const parts: (string | React.ReactElement)[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const regex = new RegExp(URL_REGEX.source, 'g');

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index));
      }
      const url = match[1];
      const trailing = url.match(/[)\]}"',;.!?]+$/);
      const cleanUrl = trailing ? url.slice(0, url.length - trailing[0].length) : url;
      const displayUrl = cleanUrl.length > 60 ? cleanUrl.slice(0, 57) + '...' : cleanUrl;
      const isTg = isTelegramLink(cleanUrl);
      if (isTg) {
        parts.push(
          <a key={match.index} href="#" onClick={e => { e.preventDefault(); handleTelegramLink(cleanUrl); }} className="message-link message-link-tg">{displayUrl}</a>
        );
      } else {
        parts.push(
          <a key={match.index} href={cleanUrl} target="_blank" rel="noopener noreferrer" className="message-link">{displayUrl}</a>
        );
      }
      lastIndex = match.index + cleanUrl.length;
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }
    return parts;
  };

  useEffect(() => {
    fetchDialogs();
    
    window.electronAPI.onDownloadProgress((data) => {
      setProgress({
        total: data.total,
        downloaded: data.downloaded,
        currentFile: data.currentFile,
        topicTitle: data.topicTitle,
        isScanning: data.isScanning
      });
    });
  }, []);

  useEffect(() => {
    handleTelegramLinkRef.current = handleTelegramLink;
  });

  useEffect(() => {
    window.electronAPI.onDeepLink((url) => {
      handleTelegramLinkRef.current?.(url);
    });
  }, []);

  useEffect(() => {
    if (selectedChat) {
      shouldScrollToBottomRef.current = true;
      setIsDownloadModalOpen(false);
      setForumTopics([]);
      setSelectedTopicId('all');
      setViewingTopic(null);
      fetchForumTopics(selectedChat);
      if (!selectedChat.hasTopics) {
        loadMessages(selectedChat.id);
      }
    } else {
      setMessages([]);
      setHasMoreMessages(false);
      setOldestMessageId(null);
      setForumTopics([]);
      setSelectedTopicId('all');
      setViewingTopic(null);
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

  const handleSelectTopic = (topic: ForumTopic) => {
    setViewingTopic(topic);
    setSelectedTopicId(String(topic.id));
    loadMessages(selectedChat!.id, 0, topic.id);
  };

  const handleBackToTopics = () => {
    setViewingTopic(null);
    setSelectedTopicId('all');
    setMessages([]);
    setHasMoreMessages(false);
    setOldestMessageId(null);
  };

  const handleViewAllTopics = () => {
    setViewingTopic({ id: 0, title: 'Todos os tópicos', topMessageId: 0, unreadCount: 0, closed: false, pinned: false });
    setSelectedTopicId('all');
    loadMessages(selectedChat!.id);
  };

  const topicColors = [
    '#5ca9e6, #7d95ff',
    '#e8786e, #f5a623',
    '#6ec6b8, #43a047',
    '#ab7ae6, #e66fa0',
    '#f5a623, #f7c948',
    '#5cb8e6, #4fc3f7',
    '#e66fa0, #ef5350',
    '#66bb6a, #aed581',
  ];

  const getTopicColor = (id: number) => {
    const idx = Math.abs(id) % topicColors.length;
    return topicColors[idx];
  };

  const loadMessages = async (chatId: string, offsetId = 0, topicId?: number) => {
    setLoadingMessages(true);
    try {
      const res = await window.electronAPI.getMessages({ chatId, limit: PAGE_SIZE, offsetId, topicId });
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
        offsetId: oldestMessageId,
        topicId: viewingTopic?.id
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
    setStopping(false);
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
      setStopping(false);
    }
  };

  const handleStopDownload = async () => {
    console.log('Stop button clicked');
    setStopping(true);
    await window.electronAPI.stopDownload();
  };

  useEffect(() => {
    const handleClickOutside = () => setIsTopicDropdownOpen(false);
    if (isTopicDropdownOpen) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [isTopicDropdownOpen]);

  if (loading) return (
    <div className="full-screen-loader fade-in">
      <div className="loader-content">
        <div className="spinner large-spinner"></div>
        <p>Summoning your chats...</p>
      </div>
    </div>
  );

  return (
    <div className={`dashboard-container fade-in ${isLightTheme ? 'light-theme' : ''}`}>
      <div className="sidebar glass-panel">
        <div className="sidebar-header">
          <div className="sidebar-header-top">
            <div className="sidebar-title-group">
              <h3>Chats</h3>
              <button
                type="button"
                className={`btn-icon ${isLightTheme ? 'active' : ''}`}
                onClick={() => setIsLightTheme(current => !current)}
                aria-label={isLightTheme ? 'Ativar modo escuro' : 'Ativar modo claro'}
                title={isLightTheme ? 'Ativar modo escuro' : 'Ativar modo claro'}
              >
                {isLightTheme ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className={`btn-icon search-toggle ${isSearchOpen ? 'active' : ''}`}
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
                className="input-glass"
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
          <div className="chat-header glass-panel">
            <div className="chat-header-info">
              {selectedChat.hasTopics && viewingTopic && (
                <button className="btn-icon" onClick={handleBackToTopics} aria-label="Voltar para tópicos">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              )}
              <div className="chat-avatar small">
                 <ChatAvatar chatId={selectedChat.id} title={selectedChat.title} />
              </div>
              <div className="chat-header-text">
                <h2>{viewingTopic ? viewingTopic.title : selectedChat.title}</h2>
                <span>
                  {viewingTopic
                    ? `${selectedChat.title} · ${getChatKind(selectedChat)} · ${messages.length} mensagens`
                    : `${getChatKind(selectedChat)}${selectedChat.hasTopics ? ' · tópicos' : ''} · ${messages.length} mensagens`}
                </span>
              </div>
            </div>
            
            <div className="chat-header-actions">
              <button className="btn-icon" onClick={() => setIsMenuOpen(!isMenuOpen)}>⋮</button>
              {isMenuOpen && (
                <div className="dropdown-menu glass-panel">
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
          <div className="chat-header empty-header glass-panel">
             <div className="chat-header-text">
               <h2>Telegram Enchanted</h2>
               <span>Escolha um chat para abrir o histórico</span>
             </div>
          </div>
        )}

        {/* Mass Download Inline Panel */}
        {isDownloadModalOpen && selectedChat && (
          <div className="inline-download-panel glass-panel slide-down">
            <div className="inline-panel-header">
               <div className="inline-panel-title">
                 <span className="magic-icon">🪄</span>
                 <h3>Enchanted Mass Download</h3>
               </div>
               <button className="btn-icon" onClick={() => setIsDownloadModalOpen(false)}>×</button>
            </div>
            
            <div className="inline-panel-body">
              <div className="folder-selection inline-folder">
                <input 
                  type="text" 
                  className="input-glass"
                  readOnly 
                  value={folderPath} 
                  placeholder="Select destination folder..." 
                />
                <button className="btn btn-secondary" onClick={handleSelectFolder}>Browse</button>
              </div>

              {selectedChat.hasTopics && (
                <div className="topic-selection">
                  <div className={`custom-select ${isTopicDropdownOpen ? 'open' : ''} ${loadingTopics || downloading ? 'disabled' : ''}`}>
                    <button
                      type="button"
                      className="custom-select-trigger input-glass"
                      onClick={e => { e.stopPropagation(); if (!loadingTopics && !downloading) setIsTopicDropdownOpen(v => !v); }}
                      disabled={loadingTopics || downloading}
                      aria-label="Selecionar tópico para mass download"
                    >
                      <span className="custom-select-value">
                        {loadingTopics ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                            <span className="spinner small-spinner" style={{ borderTopColor: 'var(--accent-primary)' }}></span> Carregando tópicos...
                          </span>
                        ) : selectedTopicId === 'all' ? 'Todos os tópicos' : forumTopics.find(t => String(t.id) === selectedTopicId)?.title || 'Todos os tópicos'}
                      </span>
                      <svg className="custom-select-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    {isTopicDropdownOpen && (
                      <div className="custom-select-options glass-panel">
                        <div className="custom-select-search" onClick={e => e.stopPropagation()}>
                          <input
                            type="text"
                            className="input-glass"
                            placeholder="Pesquisar tópicos..."
                            value={topicSearch}
                            onChange={e => setTopicSearch(e.target.value)}
                            autoFocus
                          />
                        </div>
                        <button
                          type="button"
                          className={`custom-select-option ${selectedTopicId === 'all' ? 'selected' : ''}`}
                          onClick={e => { e.stopPropagation(); setSelectedTopicId('all'); setIsTopicDropdownOpen(false); setTopicSearch(''); }}
                        >
                          Todos os tópicos
                        </button>
                        {filteredTopics.map(topic => (
                          <button
                            key={topic.id}
                            type="button"
                            className={`custom-select-option ${String(topic.id) === selectedTopicId ? 'selected' : ''}`}
                            onClick={e => { e.stopPropagation(); setSelectedTopicId(String(topic.id)); setIsTopicDropdownOpen(false); setTopicSearch(''); }}
                          >
                            {topic.pinned && <span className="option-pin">📌</span>}
                            {topic.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              
              {downloading ? (
                <button 
                  className={`btn btn-danger stop-btn ${stopping ? 'disabled' : ''}`} 
                  onClick={handleStopDownload}
                  disabled={stopping}
                >
                  <span className="stop-icon">{stopping ? '⏳' : '⏹'}</span> 
                  {stopping ? 'Stopping...' : 'Stop Download'}
                </button>
              ) : (
                <button 
                  className="btn btn-primary" 
                  onClick={handleStartDownload}
                  disabled={!folderPath || loadingTopics}
                >
                  Start Download
                </button>
              )}
            </div>

            {progress && (
              <div className="inline-progress-container glass-panel fade-in">
                <div className="progress-header">
                  <span className="progress-status">
                    {progress.topicTitle ? `${progress.topicTitle} · ${progress.currentFile}` : progress.currentFile}
                  </span>
                  <span className="progress-count">
                    {progress.isScanning ? 'Scanning...' : `${Math.floor(progress.downloaded)} files / ${progress.total} total`}
                  </span>
                </div>
                <div className="progress-bar inline-progress">
                  <div 
                    className={`progress-fill ${downloading ? 'animated-stripes' : ''} ${progress.isScanning ? 'scanning-fill' : ''}`} 
                    style={{ width: (progress.total > 0 && !progress.isScanning) ? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` : '100%' }}
                  ></div>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedChat ? (
          <div className="content-layout slide-up" key={selectedChat.id + (viewingTopic ? `-topic-${viewingTopic.id}` : '-topics')}>
            
            {selectedChat.hasTopics && !viewingTopic ? (
              <div className="chat-viewer full-width">
                <div className="chat-messages" onClick={() => isMenuOpen && setIsMenuOpen(false)}>
                  {loadingTopics ? (
                    <div className="messages-loading">
                      <span className="spinner"></span> Carregando tópicos...
                    </div>
                  ) : forumTopics.length === 0 ? (
                    <div className="messages-empty">Nenhum tópico encontrado.</div>
                  ) : (
                    <div className="topic-list">
                      <div className="topic-search-container">
                        <input
                          type="text"
                          className="input-glass"
                          placeholder="Pesquisar tópicos..."
                          value={topicSearch}
                          onChange={e => setTopicSearch(e.target.value)}
                        />
                      </div>
                      <div
                        className="topic-item topic-item-all"
                        onClick={handleViewAllTopics}
                      >
                        <div className="topic-item-avatar topic-item-avatar-all">
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </div>
                        <div className="topic-item-content">
                          <div className="topic-item-name">Todos os tópicos</div>
                          <div className="topic-item-sub">Ver mensagens de todos os tópicos</div>
                        </div>
                      </div>
                      <div className="topic-list-divider"></div>
                      {filteredTopics.map(topic => (
                        <div
                          key={topic.id}
                          className="topic-item"
                          onClick={() => handleSelectTopic(topic)}
                        >
                          <div
                            className="topic-item-avatar"
                            style={{ background: `linear-gradient(135deg, ${getTopicColor(topic.id)})` }}
                          >
                            {topic.title.charAt(0).toUpperCase()}
                          </div>
                          <div className="topic-item-content">
                            <div className="topic-item-name">
                              {topic.title}
                              {topic.pinned && <span className="topic-pin">📌</span>}
                            </div>
                            <div className="topic-item-sub">
                              {topic.unreadCount > 0 ? (
                                <>{topic.unreadCount} mensagens não lidas{topic.closed ? ' · Fechado' : ''}</>
                              ) : (
                                <>{topic.closed ? 'Fechado' : 'Aberto'}</>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
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
                          className="btn btn-secondary"
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
                                <MessageMedia chatId={selectedChat.id} messageId={msg.id} isVideo={msg.isVideo} mediaSize={msg.mediaSize} />
                              )}
                              {msg.text && <div className="message-text">{linkifyText(msg.text)}</div>}
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
            )}
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
