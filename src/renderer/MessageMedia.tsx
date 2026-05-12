import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu } from './ContextMenu';

interface Props {
  chatId: string;
  messageId: number;
  isVideo: boolean;
  mediaSize?: number | null;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
}

const IconDownload = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" x2="12" y1="15" y2="3"/>
  </svg>
);

export const MessageMedia: React.FC<Props> = ({ chatId, messageId, isVideo, mediaSize }) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [fullMediaSrc, setFullMediaSrc] = useState<string | null>(null);
  const [videoStreamUrl, setVideoStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [loadingFullMedia, setLoadingFullMedia] = useState(false);
  const [savingMedia, setSavingMedia] = useState(false);
  const [mediaProgress, setMediaProgress] = useState(0);
  const [mediaStage, setMediaStage] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 });

  useEffect(() => {
    let isMounted = true;

    const fetchMedia = async () => {
      try {
        const res = await window.electronAPI.getMessageMedia({ chatId, messageId });

        if (!isMounted || !res.success) return;

        if (res.base64) {
          setPreviewSrc(`data:image/jpeg;base64,${res.base64}`);
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchMedia();

    return () => {
      isMounted = false;
    };
  }, [chatId, messageId]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMediaProgress((data) => {
      if (data.chatId !== chatId || data.messageId !== messageId) return;
      setMediaProgress(data.progress);
      setMediaStage(data.stage);
    });

    return () => {
      unsubscribe();
    };
  }, [chatId, messageId]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  if (loading) {
    return (
      <div className="media-preview loading-media">
        <span className="spinner small-spinner"></span>
      </div>
    );
  }

  const loadFullMedia = async () => {
    if (fullMediaSrc || loadingFullMedia) return;

    setLoadingFullMedia(true);
    setMediaStage('downloading');

    try {
      const res = await window.electronAPI.getMessageMediaFile({ chatId, messageId });
      if (res.success && res.base64 && res.mimeType) {
        setFullMediaSrc(`data:${res.mimeType};base64,${res.base64}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingFullMedia(false);
    }
  };

  const loadVideoStream = async () => {
    if (videoStreamUrl || loadingFullMedia) return;

    setLoadingFullMedia(true);
    setMediaStage('streaming');

    try {
      const res = await window.electronAPI.getMessageMediaStream({ chatId, messageId });
      if (res.success && res.streamUrl) {
        setVideoStreamUrl(res.streamUrl);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingFullMedia(false);
    }
  };

  const handleOpen = async () => {
    setIsOpen(true);
    if (isVideo) {
      await loadVideoStream();
      return;
    }

    await loadFullMedia();
  };

  const handleSaveMedia = async () => {
    if (savingMedia) return;

    setSavingMedia(true);
    setMediaStage('downloading');

    try {
      await window.electronAPI.saveMessageMediaFile({ chatId, messageId });
    } catch (e) {
      console.error(e);
    } finally {
      setSavingMedia(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

  const contextMenuItems = [
    {
      label: 'Salvar como...',
      icon: <IconDownload />,
      onClick: handleSaveMedia,
      disabled: savingMedia,
    },
  ];

  const canOpenViewer = Boolean(previewSrc || fullMediaSrc || isVideo);
  const shouldShowProgress = loadingFullMedia || savingMedia || (mediaProgress > 0 && mediaProgress < 100);
  const progressLabel = mediaStage === 'streaming' ? 'Streaming' : 'Carregando';

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  if (previewSrc || fullMediaSrc || isVideo) {
    return (
      <>
        <button
          type="button"
          className={`media-preview media-preview-button ${isVideo ? 'is-video' : 'is-image'}`}
          onClick={() => canOpenViewer && handleOpen()}
          disabled={!canOpenViewer}
        >
          {previewSrc ? (
            <img
              src={previewSrc}
              alt="Media"
              className="media-img"
              onContextMenu={handleContextMenu}
            />
          ) : (
            <div className="media-preview failed" onContextMenu={handleContextMenu}>
              Video
            </div>
          )}
          {shouldShowProgress && (
            <div className="media-progress-badge">
              {progressLabel} {mediaProgress}%
            </div>
          )}
          {isVideo && <div className="video-play-icon">▶</div>}
          {isVideo && mediaSize && (
            <div className="media-size-chip">
              {formatBytes(mediaSize)}
            </div>
          )}
        </button>

        {contextMenu.visible && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={closeContextMenu}
          />
        )}

        {isOpen && createPortal(
          <div className="media-lightbox" onClick={() => setIsOpen(false)}>
            <div className="media-lightbox-toolbar" onClick={event => event.stopPropagation()}>
              <button
                type="button"
                className="btn-icon"
                onClick={handleSaveMedia}
                disabled={savingMedia}
                title={savingMedia ? 'Salvando...' : 'Download'}
                aria-label="Salvar mídia"
              >
                {savingMedia ? <span className="spinner small-spinner"></span> : '⤓'}
              </button>
              <button
                type="button"
                className="btn-icon"
                onClick={() => setIsOpen(false)}
                aria-label="Fechar visualizacao de midia"
              >
                ×
              </button>
            </div>
            <div
              className={`media-lightbox-content ${isVideo ? 'video-content' : 'image-content'}`}
              onClick={event => event.stopPropagation()}
            >
              {loadingFullMedia ? (
                <div className="media-lightbox-loading">
                  <div className="media-lightbox-progress">
                    <span className="spinner"></span>
                    <span>{progressLabel} {mediaProgress}%</span>
                  </div>
                </div>
              ) : isVideo && videoStreamUrl ? (
                <div className="media-video-shell">
                  <video
                    className="media-video-player"
                    src={videoStreamUrl}
                    controls
                    autoPlay
                    playsInline
                    preload="auto"
                    onContextMenu={handleContextMenu}
                  />
                  {shouldShowProgress && (
                    <div className="media-stream-progress-overlay">
                      {progressLabel} {mediaProgress}%
                    </div>
                  )}
                </div>
              ) : fullMediaSrc ? (
                <img
                  src={fullMediaSrc}
                  alt="Media expandida"
                  className="media-lightbox-img"
                  onContextMenu={handleContextMenu}
                />
              ) : (
                <div className="media-preview failed">Midia indisponivel</div>
              )}
            </div>

            {contextMenu.visible && (
              <ContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                items={contextMenuItems}
                onClose={closeContextMenu}
              />
            )}
          </div>,
          document.querySelector('.dashboard-container') || document.body
        )}
      </>
    );
  }

  return <div className="media-preview failed">[Media]</div>;
};
