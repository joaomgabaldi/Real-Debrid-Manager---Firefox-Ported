import { localizeHtmlPage, i18n } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
  localizeHtmlPage();

  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  const title = params.get('title');
  const player = document.getElementById('player');

  if (title) {
    document.title = title;
    document.getElementById('title').textContent = title;
  }

  if (url) {
    player.src = url;
    document.getElementById('btn-dl').href = url;
    
    const vlcBtn = document.getElementById('btn-vlc');
    vlcBtn.href = '#';
    vlcBtn.addEventListener('click', (e) => {
      e.preventDefault();
      
      const safeFilename = (title || i18n('defaultVideoName')).replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const m3uContent = `#EXTM3U\n#EXTINF:-1,${title || i18n('defaultStreamName')}\n${url}`;
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
    });

  } else {
    document.getElementById('title').textContent = i18n('errorNoUrl');
  }

  setupCustomControls(player);
  setupSubtitleDragAndDrop(player);
});

function setupCustomControls(video) {
  const videoContainer = document.getElementById('drop-zone');
  const btnPlayPause = document.getElementById('btn-play-pause');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnMute = document.getElementById('btn-mute');
  const iconVolHigh = document.getElementById('icon-vol-high');
  const iconVolMute = document.getElementById('icon-vol-mute');
  const volumeSlider = document.getElementById('volume-slider');
  const timeDisplay = document.getElementById('time-display');
  const progressContainer = document.getElementById('progress-container');
  const progressFilled = document.getElementById('progress-filled');
  const btnFullscreen = document.getElementById('btn-fullscreen');
  const iconFsEnter = document.getElementById('icon-fs-enter');
  const iconFsExit = document.getElementById('icon-fs-exit');
  
  let idleTimeout;

  // Lógica de inatividade (Ocultar cursor e controles)
  const resetIdleTimer = () => {
    videoContainer.classList.remove('idle');
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      if (!video.paused) {
        videoContainer.classList.add('idle');
      }
    }, 2500);
  };

  videoContainer.addEventListener('mousemove', resetIdleTimer);
  videoContainer.addEventListener('click', resetIdleTimer);
  video.addEventListener('play', resetIdleTimer);
  video.addEventListener('pause', () => videoContainer.classList.remove('idle'));

  // Play/Pause
  const togglePlay = () => {
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  };

  btnPlayPause.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);

  video.addEventListener('play', () => {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
  });

  video.addEventListener('pause', () => {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
  });

  // Atualização de Progresso e Tempo
  const formatTime = (timeInSeconds) => {
    const result = new Date(timeInSeconds * 1000).toISOString().substr(11, 8);
    return result.startsWith('00:') ? result.substr(3) : result;
  };

  const handleProgress = () => {
    if (!video.duration) return;
    const percent = (video.currentTime / video.duration) * 100;
    progressFilled.style.width = `${percent}%`;
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  };

  video.addEventListener('timeupdate', handleProgress);
  video.addEventListener('loadedmetadata', handleProgress);

  // Navegação pelo progresso (Seek)
  progressContainer.addEventListener('click', (e) => {
    const rect = progressContainer.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    video.currentTime = pos * video.duration;
  });

  // Volume
  volumeSlider.addEventListener('input', (e) => {
    video.volume = e.target.value;
    video.muted = e.target.value === '0';
  });

  video.addEventListener('volumechange', () => {
    volumeSlider.value = video.muted ? 0 : video.volume;
    if (video.muted || video.volume === 0) {
      iconVolHigh.style.display = 'none';
      iconVolMute.style.display = 'block';
    } else {
      iconVolHigh.style.display = 'block';
      iconVolMute.style.display = 'none';
    }
  });

  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
  });

  // Tela Cheia
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      // Solicitamos fullscreen no container para exibir os controles customizados junto
      if (videoContainer.requestFullscreen) {
        videoContainer.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  btnFullscreen.addEventListener('click', toggleFullscreen);
  video.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      iconFsEnter.style.display = 'none';
      iconFsExit.style.display = 'block';
    } else {
      iconFsEnter.style.display = 'block';
      iconFsExit.style.display = 'none';
    }
  });

  // Legendas (CC) - Lógica do Botão
  const btnCc = document.getElementById('btn-cc');
  btnCc.addEventListener('click', () => {
    if (video.textTracks && video.textTracks.length > 0) {
      const track = video.textTracks[0];
      if (track.mode === 'showing') {
        track.mode = 'hidden';
        btnCc.style.opacity = '0.5';
      } else {
        track.mode = 'showing';
        btnCc.style.opacity = '1';
      }
    }
  });
}

function setupSubtitleDragAndDrop(videoElement) {
  const dropZone = document.getElementById('drop-zone');
  const dragOverlay = document.getElementById('drag-overlay');
  const btnCc = document.getElementById('btn-cc');

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dragOverlay.classList.add('active');
  });

  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (!e.relatedTarget || !dropZone.contains(e.relatedTarget)) {
      dragOverlay.classList.remove('active');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.classList.remove('active');

    const file = e.dataTransfer.files[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    const isSrt = fileName.endsWith('.srt');
    const isVtt = fileName.endsWith('.vtt');

    if (!isSrt && !isVtt) {
      alert(i18n('errorInvalidSubtitleFormat') || 'Formato inválido. Por favor, use um arquivo .SRT ou .VTT.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const buffer = event.target.result;
      const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
      let subtitleText;

      try {
        subtitleText = utf8Decoder.decode(new Uint8Array(buffer));
      } catch (err) {
        const latinDecoder = new TextDecoder('windows-1252');
        subtitleText = latinDecoder.decode(new Uint8Array(buffer));
      }

      if (isSrt) {
        subtitleText = convertSrtToVtt(subtitleText);
      }

      const blob = new Blob([subtitleText], { type: 'text/vtt;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);

      Array.from(videoElement.querySelectorAll('track')).forEach(t => t.remove());

      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = file.name;
      track.srclang = 'pt';
      track.src = blobUrl;
      track.default = true;

      videoElement.appendChild(track);

      if (videoElement.textTracks && videoElement.textTracks.length > 0) {
        videoElement.textTracks[0].mode = 'showing';
        // Habilita o botão CC visualmente na interface customizada
        btnCc.classList.remove('disabled');
        btnCc.title = 'Alternar Legendas';
        btnCc.style.opacity = '1';
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

function convertSrtToVtt(srtContent) {
  let vtt = 'WEBVTT\n\n';
  vtt += srtContent.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}
