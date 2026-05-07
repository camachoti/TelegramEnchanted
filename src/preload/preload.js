import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  sendCode: (phoneNumber) => ipcRenderer.invoke('telegram:send-code', phoneNumber),
  signIn: (data) => ipcRenderer.invoke('telegram:sign-in', data),
  checkAuth: () => ipcRenderer.invoke('telegram:check-auth'),
});