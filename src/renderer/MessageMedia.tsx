import React, { useEffect, useState } from 'react';

interface Props {
  chatId: string;
  messageId: number;
  isVideo: boolean;
}

export const MessageMedia: React.FC<Props> = ({ chatId, messageId, isVideo }) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [fullMediaSrc, setFullMediaSrc] = useState<string | null>(null);
  const [videoStreamUrl, setVideoStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);
  const [loadingFullMedia, setLoadingFullMedia] = useState(false);
  const [savingMedia, setSavingMedia] = useState(false);
  const [mediaProgress, setMediaProgress] = useState(0);
  const [mediaStage, setMediaStage] = useState<string | null>(null);

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

  const canOpenViewer = Boolean(previewSrc || fullMediaSrc || isVideo);
  const shouldShowProgress = loadingFullMedia || savingMedia || (mediaProgress > 0 && mediaProgress < 100);
  const progressLabel = mediaStage === 'streaming' ? 'Streaming' : 'Carregando';

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
            <img src={previewSrc} alt="Media" className="media-img" />
          ) : (
            <div className="media-preview failed">Video</div>
          )}
          {shouldShowProgress && (
            <div className="media-progress-badge">
              {progressLabel} {mediaProgress}%
            </div>
          )}
          {isVideo && <div className="video-play-icon">▶</div>}
        </button>

        {isOpen && (
          <div className="media-lightbox" onClick={() => setIsOpen(false)}>
            <div className="media-lightbox-toolbar" onClick={event => event.stopPropagation()}>
              <button
                type="button"
                className="media-lightbox-action"
                onClick={handleSaveMedia}
                disabled={savingMedia}
                aria-label="Salvar midia"
              >
                {savingMedia ? 'Salvando...' : 'Download'}
              </button>
              <button
                type="button"
                className="media-lightbox-close"
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
                  <video className="media-video-player" src={videoStreamUrl} controls autoPlay playsInline preload="auto" />
                  {shouldShowProgress && (
                    <div className="media-stream-progress-overlay">
                      {progressLabel} {mediaProgress}%
                    </div>
                  )}
                </div>
              ) : fullMediaSrc ? (
                <img src={fullMediaSrc} alt="Media expandida" className="media-lightbox-img" />
              ) : (
                <div className="media-preview failed">Midia indisponivel</div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }

  return <div className="media-preview failed">[Media]</div>;
};
