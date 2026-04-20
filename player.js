import { localizeHtmlPage } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
  localizeHtmlPage(); // Traduz os botões do player

  const params = new URLSearchParams(window.location.search);
  const url = params.get('url');
  const title = params.get('title');

  if (title) {
    document.title = title;
    document.getElementById('title').textContent = title;
  }

  if (url) {
    document.getElementById('player').src = url;
    document.getElementById('btn-dl').href = url;
    document.getElementById('btn-vlc').href = 'vlc://' + url;
  } else {
    document.getElementById('title').textContent = 'Erro: URL não fornecida.';
  }
});
