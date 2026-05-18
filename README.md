# RD Manager for Real-Debrid

[![Firefox Add-on](https://img.shields.io/badge/Firefox-Add--on-orange)](https://addons.mozilla.org/pt-BR/firefox/addon/rd-manager-for-real-debrid/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

O **RD Manager** é uma extensão de código aberto para Firefox projetada para gerenciar contas do Real-Debrid de forma nativa, rápida e segura. A ferramenta permite o gerenciamento completo de torrents, magnets e desbloqueio de links premium sem a necessidade de acessar o site oficial.

## 🚀 Diferenciais Técnicos

Este projeto surgiu como um port da extensão "Real-Debrid Lite" (Chrome), mas foi totalmente reescrito e aprimorado com foco em segurança e escalabilidade:

* **Autenticação Segura (OAuth2):** Diferente de outras extensões que solicitam a sua "API Key" privada, o RD Manager utiliza o fluxo oficial de dispositivos OAuth2. Suas credenciais nunca são expostas.
* **Sem Limite de Histórico:** Implementa paginação dinâmica para carregar todo o seu histórico de torrents, superando o limite padrão de 50 itens de outras ferramentas.
* **Otimização de API:** Lógica de requisições aprimorada para evitar banimentos por excesso de chamadas (Rate Limiting).
* **Integração Nativa com JDownloader 2:** Envio direto de links para a instância local do JD2 via porta 9666.
* **Vanilla Stack:** Desenvolvido puramente com HTML, CSS e JavaScript (ES6+), sem processos de build complexos ou dependências pesadas.

## 🛠️ Funcionalidades

- [x] Adição de links Magnet e arquivos `.torrent` via janela popup dedicada (evitando perda de foco do navegador).
- [x] Seleção manual de arquivos dentro de um pacote torrent antes do início do download.
- [x] Desbloqueio de links premium (Hosters) em lote diretamente pela extensão.
- [x] Streaming de vídeo integrado no navegador ou envio externo para o VLC Media Player (via geração de `.m3u`).
- [x] Visualização detalhada e expansível dos arquivos internos de pacotes torrent já concluídos.
- [x] Gestão em lote para seleção de múltiplos itens e exclusão simultânea (executada em background).
- [x] Integração avançada com o JDownloader 2 (com suporte à autorização permanente no sistema *Extern Interface Auth*).
- [x] Exibição rápida do status da conta (tipo de plano e dias restantes de assinatura Premium).
- [x] Sistema de notificações nativas para conclusão de downloads em tempo real.
- [x] Filtros avançados e navegação por abas de status, tipo de arquivo e idade (1 dia, 1 semana, 1 mês).
- [x] Busca instantânea no histórico completo de downloads.
- [x] Menu de contexto integrado para envio rápido de links de qualquer página.
- [x] Sincronização em segundo plano e atualização automática de status (auto-refresh dinâmico).
- [x] Suporte completo a Temas Claro e Escuro.
- [x] Internacionalização com suporte nativo a múltiplos idiomas (Português, Inglês e Espanhol).

## 📦 Instalação

### Oficial (Recomendado)
Instale diretamente pela loja de extensões da Mozilla:
[RD Manager na Firefox Add-ons (AMO)](https://addons.mozilla.org/pt-BR/firefox/addon/rd-manager-for-real-debrid/)

### Desenvolvimento (Manual)
1. Clone este repositório: `git clone https://github.com/joaomgabaldi/RD-Manager.git`
2. Abra o Firefox e digite `about:debugging` na barra de endereços.
3. Clique em "Este Firefox" e depois em "Carregar extensão temporária".
4. Selecione o arquivo `manifest.json` na pasta do projeto.

## 🤝 Créditos

Este projeto foi baseado na extensão [Real-Debrid Lite](https://chromewebstore.google.com/detail/real-debrid-lite-%E2%80%93-downlo/jhiocmjcclljkmmadpcaffanijehfpco) do Chrome. Agradeço aos desenvolvedores originais.

## 📄 Licença

Este projeto está sob a licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

---
Desenvolvido com orgulho no 🇧🇷.
