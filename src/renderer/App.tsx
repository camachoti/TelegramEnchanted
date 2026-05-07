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
          <div className="logo-placeholder">🪄</div>
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