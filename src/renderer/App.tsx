import React, { useState, useEffect } from 'react';
import './App.css';
import { Dashboard } from './Dashboard';

function App() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const checkLoginStatus = async () => {
      setIsLoading(true);
      try {
        const res = await window.electronAPI.checkAuth();
        if (res.isAuthorized) {
          setIsLoggedIn(true);
        }
      } catch (e) {
        console.error("Failed to check auth status", e);
      } finally {
        setIsLoading(false);
      }
    };
    
    checkLoginStatus();
  }, []);

  const handleSendCode = async () => {
    if (!phone) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await window.electronAPI.sendCode(phone);
      if (res.success && res.phoneCodeHash) {
        setPhoneCodeHash(res.phoneCodeHash);
      } else {
        setError(res.error || 'Failed to send code');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignIn = async () => {
    if (!phoneCodeHash || !code) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await window.electronAPI.signIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code });
      if (res.success) {
        setIsLoggedIn(true);
      } else {
        setError(res.error || 'Failed to sign in');
      }
    } catch (e: any) {
      setError(e.message || 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoggedIn) {
    return <Dashboard />;
  }

  return (
    <div className="App">
      <div className="login-container fade-in">
        <div className="login-header">
          <div className="logo-placeholder">
            <svg viewBox="0 0 512 512" width="72" height="72" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="lgBg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#3390ec"/>
                  <stop offset="100%" stopColor="#1c6dba"/>
                </linearGradient>
                <linearGradient id="lgWand" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#ffffff"/>
                  <stop offset="100%" stopColor="#d0e8ff"/>
                </linearGradient>
                <linearGradient id="lgStar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffe566"/>
                  <stop offset="50%" stopColor="#ffd700"/>
                  <stop offset="100%" stopColor="#ffb800"/>
                </linearGradient>
                <filter id="lgGlow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b"/>
                  <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                </filter>
              </defs>
              <circle cx="256" cy="256" r="232" fill="url(#lgBg)"/>
              <g transform="rotate(-45, 256, 256)">
                <rect x="248" y="120" width="16" height="200" rx="8" fill="url(#lgWand)"/>
                <rect x="248" y="100" width="16" height="30" rx="8" fill="url(#lgStar)"/>
              </g>
              <g transform="translate(256,268) scale(1.15)">
                <path d="M-74 14L102-76C110-80 118-74 116-66L76 50C74 56 68 60 62 58L-10 30L-74 14Z" fill="url(#lgWand)" opacity="0.9"/>
                <path d="M-10 30L-74 14L76 50Z" fill="#c8e1ff" opacity="0.5"/>
              </g>
              <g filter="url(#lgGlow)">
                <path d="M340 100 L344 112 L356 116 L344 120 L340 132 L336 120 L324 116 L336 112Z" fill="url(#lgStar)"/>
                <path d="M140 120 L143 129 L152 132 L143 135 L140 144 L137 135 L128 132 L137 129Z" fill="#ffe87a" opacity="0.9"/>
                <circle cx="380" cy="320" r="3" fill="#ffd54f" opacity="0.7"/>
                <circle cx="370" cy="140" r="2" fill="#ffd700" opacity="0.65"/>
              </g>
            </svg>
          </div>
          <h1>Telegram Enchanted</h1>
          <p>Mass Media Downloader</p>
        </div>
        
        {error && <div className="error-message shake">{error}</div>}
        
        {!phoneCodeHash ? (
          <div className="login-form slide-up">
            <label>Phone Number</label>
            <input 
              type="text" 
              placeholder="+123456789" 
              value={phone} 
              onChange={e => setPhone(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && phone && !isLoading) handleSendCode(); }}
              disabled={isLoading}
              autoFocus
            />
            <button onClick={handleSendCode} disabled={isLoading || !phone}>
              {isLoading ? <span className="spinner"></span> : 'Send Code'}
            </button>
          </div>
        ) : (
          <div className="login-form slide-up">
            <label>Enter Code sent to your Telegram</label>
            <input 
              type="text" 
              placeholder="12345" 
              value={code} 
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && code && !isLoading) handleSignIn(); }}
              disabled={isLoading}
              autoFocus
            />
            <button onClick={handleSignIn} disabled={isLoading || !code}>
              {isLoading ? <span className="spinner"></span> : 'Sign In'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;