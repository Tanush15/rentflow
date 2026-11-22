/* Small bridge bundled into public/js/native.js by `npm run build:native`.
   Gives the shared web app access to native phone features without a frontend build step. */
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Camera, CameraSource, CameraResultType } from '@capacitor/camera';
import { Share } from '@capacitor/share';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Network } from '@capacitor/network';

const isNative = Capacitor.isNativePlatform();
const platform = Capacitor.getPlatform();

async function openExternal(url) {
  if (!url) return;
  try {
    if (isNative) await Browser.open({ url, presentationStyle: 'popover' });
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    window.open(url, '_blank', 'noopener');
  }
}

async function shareOrCopy({ title, text, url }) {
  try {
    if (isNative) {
      await Share.share({ title, text, url, dialogTitle: 'Share RentFlow' });
      return 'shared';
    }
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return 'shared';
    }
    await navigator.clipboard.writeText(text || url || '');
    return 'copied';
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
    try { await navigator.clipboard.writeText(text || url || ''); return 'copied'; }
    catch (_) { return 'failed'; }
  }
}

async function takePhoto() {
  const photo = await Camera.getPicture({
    sourceType: CameraSource.Camera,
    resultType: CameraResultType.DataUrl,
    quality: 75,
    allowEditing: false,
    correctOrientation: true,
  });
  const res = await fetch(photo.dataUrl);
  const blob = await res.blob();
  const ext = photo.format || 'jpg';
  return new File([blob], `camera-${Date.now()}.${ext}`, { type: blob.type || 'image/jpeg' });
}

async function pickFromGallery() {
  const photo = await Camera.getPicture({
    sourceType: CameraSource.Photos,
    resultType: CameraResultType.DataUrl,
    quality: 75,
    allowEditing: false,
    correctOrientation: true,
  });
  const res = await fetch(photo.dataUrl);
  const blob = await res.blob();
  return new File([blob], `gallery-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
}

async function setupStatusBar() {
  if (!isNative) return;
  try {
    if (platform === 'android') await StatusBar.setBackgroundColor({ color: '#123C30' });
    await StatusBar.setStyle({ style: Style.Light });
  } catch (e) { /* older OS versions may ignore this */ }
}

function onBackButton(handler) {
  if (isNative && platform === 'android') {
    App.addListener('backButton', handler);
  }
}

async function exitApp() {
  if (isNative && platform === 'android') {
    try { await App.exitApp(); } catch (e) { /* no-op */ }
  }
}

async function networkStatus() {
  if (!isNative) return { connected: navigator.onLine };
  const s = await Network.getStatus();
  return { connected: s.connected, connectionType: s.connectionType };
}

function onNetworkChange(handler) {
  if (isNative) Network.addListener('networkStatusChange', handler);
}

window.RFNative = {
  isNative,
  platform,
  openExternal,
  shareOrCopy,
  takePhoto,
  pickFromGallery,
  setupStatusBar,
  onBackButton,
  exitApp,
  networkStatus,
  onNetworkChange,
};
