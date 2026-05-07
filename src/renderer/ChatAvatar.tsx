import React, { useEffect, useState } from 'react';

interface Props {
  chatId: string;
  title: string;
}

export const ChatAvatar: React.FC<Props> = ({ chatId, title }) => {
  const [imgData, setImgData] = useState<string | null>(null);
  
  useEffect(() => {
    // Only fetch once
    const fetchAvatar = async () => {
      const res = await window.electronAPI.getAvatar(chatId);
      if (res.success && res.base64) {
        setImgData(`data:image/jpeg;base64,${res.base64}`);
      }
    };
    fetchAvatar();
  }, [chatId]);

  if (imgData) {
    return <img src={imgData} alt={title} className="chat-avatar-img" />;
  }

  return (
    <div className="chat-avatar-text">
       {title ? title.charAt(0).toUpperCase() : '?'}
    </div>
  );
};