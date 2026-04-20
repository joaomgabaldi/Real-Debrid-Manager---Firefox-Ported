export function triggerPlay(url, filename = '') {
  if (!String(url).startsWith('https://') && !String(url).startsWith('http://')) {
    toast(i18n('invalidDlLink'), 'error');
    return;
  }
  
  if (state.useVlc) {
    const safeFilename = (filename || 'video').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const m3uContent = `#EXTM3U\n#EXTINF:-1,${filename || 'RD Stream'}\n${url}`;
    const blob = new Blob([m3uContent], { type: 'application/vnd.apple.mpegurl' });
    const blobUrl = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${safeFilename}.m3u`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } else {
    const playerUrl = browser.runtime.getURL(`player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(filename)}`);
    browser.tabs.create({ url: playerUrl });
  }
}
