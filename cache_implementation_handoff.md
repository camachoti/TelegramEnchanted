# Handoff: Telegram Enchanted Cache System Implementation

Este documento descreve o estado atual da implementação do sistema de cache persistente e as tarefas pendentes para conclusão via CLI ou modelo externo.

## 📝 Contexto Técnico
O objetivo é implementar um cache persistente para mensagens, mídias (fotos/vídeos) e avatares.
- **Banco de Dados:** `node-sqlite3-wasm` (já instalado e configurado).
- **Motivo:** O ambiente Electron 32 não suporta `node:sqlite` nativo e não possui compilador `g++` para `better-sqlite3`.
- **Estratégia:** Cache-first para mídias e avatares; Persistência e detecção de edição/deleção para mensagens.

---

## ✅ O que já foi feito (BACKEND CONCLUÍDO)

1.  **`src/main/cache.js`**: Criado o gerenciador de cache com suporte a:
    - Schema SQLite (mensagens, media_files, avatars, settings).
    - Métodos de CRUD para mensagens (com detecção de edição).
    - Gerenciamento de arquivos no sistema (thumbnails, photos, videos, avatars).
    - Lógica de expiração LRU (Least Recently Used) baseada em tamanho máximo.
2.  **`src/main/main.js`**: Integrado ao ciclo de vida do app:
    - Inicialização e encerramento do banco de dados.
    - Handlers de mensagens, avatares e mídias atualizados para usar o cache.
    - Novos handlers IPC registrados: `cache:get-stats`, `cache:clear-all`, `cache:get-settings`, `cache:set-settings`, `cache:get-original-message`.
3.  **`src/preload/preload.cjs`**: APIs de cache expostas para o frontend.
4.  **`src/renderer/types.d.ts`**: Interfaces TypeScript atualizadas para incluir flags de cache (`is_deleted`, `is_edited`) e métodos da `electronAPI`.

---

## 🚀 Tarefas Pendentes (FRONTEND/UI)

### 1. Atualizar Renderização de Mensagens (`src/renderer/Dashboard.tsx`)
- **Mensagens Deletadas:** Se `msg.is_deleted` for true, aplicar classe CSS `.msg-deleted` (opacidade reduzida) e exibir um badge/texto informativo "🗑️ Mensagem excluída no servidor".
- **Mensagens Editadas:** Se `msg.is_edited` for true, exibir o texto "(editado)" ao lado do horário.
- **Menu de Contexto:** Adicionar opção "Ver mensagem original" que dispara `window.electronAPI.getOriginalMessage` e exibe o conteúdo original em um modal ou área de expansão.

### 2. Criar Componente de Configurações (`src/renderer/Settings.tsx`)
Novo arquivo para gerenciar o cache:
- Exibir estatísticas (espaço ocupado, total de mensagens/arquivos) via `getCacheStats`.
- Slider ou Dropdown para definir limite de cache (`max_cache_size`).
- Configuração de tempo de atualização de avatares.
- Botão "Limpar Cache" com confirmação.

### 3. Estilização (`src/renderer/Dashboard.css`)
Adicionar estilos para os novos estados:
- `.msg-deleted`: Opacidade 0.5, possivelmente um itálico ou borda tracejada.
- `.msg-edited-badge`: Estilo discreto para o indicador de edição.
- `.settings-panel`: Painel lateral ou modal para as configurações.
- Estilos para o visualizador da mensagem original.

---

## 🛠️ Comandos Úteis
- **Rodar o App:** `npm run dev`
- **Localização do Cache:** `app.getPath('userData')/cache/` (geralmente em `~/.config/TelegramEnchanted/cache/`)
- **Lib Utilizada:** `require('node-sqlite3-wasm')`

---
**Instrução para o Executor:** Foque agora na integração visual no `Dashboard.tsx` e na criação da interface de configurações no `Settings.tsx`. O backend e a ponte IPC estão prontos e testados.
