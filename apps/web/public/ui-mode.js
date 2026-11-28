'use strict';

// Wrapped so the helper names stay out of the page's global scope. Only
// window.SnaglyMode is shared with app.js, privacy.js and the Node tests.
(function () {
  /**
   * Mode-dependent copy and visibility. Kept in one small script so the browser
   * and the tests agree on what each mode promises, and so retention hours always
   * come from the server's capability payload instead of a hardcoded 24.
   */
  function modeOf(value) {
    if (value === 'cloud' || value === 'local') return value;
    const mode = value?.capabilities?.mode || value?.mode;
    return mode === 'cloud' ? 'cloud' : 'local';
  }

  function retentionHours(value) {
    const hours = Number(value?.retentionHours ?? value);
    return Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 24;
  }

  function hoursLabel(hours) {
    const value = retentionHours(hours);
    return `${value} hour${value === 1 ? '' : 's'}`;
  }

  function cloudRetentionNotice(hours) {
    return `Files are processed on our server and deleted after ${hoursLabel(
      hours
    )}. Save them to your device before they expire.`;
  }

  function footerCopy(mode, hours) {
    return modeOf(mode) === 'cloud'
      ? cloudRetentionNotice(hours)
      : 'Snagly runs on this computer. Nothing is uploaded.';
  }

  function emptyCopy(mode, hours) {
    return modeOf(mode) === 'cloud'
      ? cloudRetentionNotice(hours)
      : 'Paste a playlist or video above. Finished downloads appear here with their folder location.';
  }

  function expiryText(expiresAt, now = Date.now()) {
    if (!expiresAt) return '';
    const ms = new Date(expiresAt).getTime() - now;
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'expired';
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return `expires in ${minutes}m`;
    return `expires in ${Math.ceil(minutes / 60)}h`;
  }

  function expiredText(hours) {
    return `Removed after ${retentionHours(hours)}h. Paste the link again to re-download.`;
  }

  // The composer folder row only makes sense in local mode or when the browser
  // can actually write to a folder. The contract flag says the server supports
  // it; directoryPicker says this browser does.
  function showFolderPicker({ mode, fileSystemAccess, directoryPicker } = {}) {
    return modeOf(mode) !== 'cloud' || Boolean(fileSystemAccess && directoryPicker);
  }

  function showGuestChip(mode) {
    return modeOf(mode) !== 'cloud';
  }

  function showConnectionsTab(mode) {
    return modeOf(mode) !== 'cloud';
  }

  function publicVideosNote(mode) {
    return modeOf(mode) === 'cloud'
      ? "Public videos only. Private, age-restricted and members-only videos won't work."
      : '';
  }

  const SnaglyMode = Object.freeze({
    modeOf,
    retentionHours,
    hoursLabel,
    cloudRetentionNotice,
    footerCopy,
    emptyCopy,
    expiryText,
    expiredText,
    showFolderPicker,
    showGuestChip,
    showConnectionsTab,
    publicVideosNote
  });

  // Exposed on window so the page scripts and the Node tests can share it.
  if (typeof window !== 'undefined') window.SnaglyMode = SnaglyMode;
})();
