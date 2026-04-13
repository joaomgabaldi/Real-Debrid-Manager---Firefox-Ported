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
- [x] Sistema de notificações nativas para conclusão de downloads em tempo real.
- [x] Filtros avançados por idade do arquivo (1 dia, 1 semana, 1 mês).
- [x] Busca instantânea no histórico de downloads.
- [x] Suporte completo a Temas Claro e Escuro.
- [x] Menu de contexto para envio rápido de links.

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

Este projeto foi inspirado na extensão [Real-Debrid Lite](https://chromewebstore.google.com/detail/real-debrid-lite-%E2%80%93-downlo/jhiocmjcclljkmmadpcaffanijehfpco) do Chrome. Agradeço aos desenvolvedores originais pela base conceitual.

## 📄 Licença

Este projeto está sob a licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

---
Desenvolvido por [João Marcos Gabaldi](https://github.com/joaomgabaldi)
