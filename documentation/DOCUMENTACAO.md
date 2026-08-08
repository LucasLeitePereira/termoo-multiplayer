# Termo Multiplayer — Documentação técnica

## 1. Visão geral

Uma versão em dupla do jogo Termo (variação do Wordle/Forca). Dois jogadores entram na mesma sala, tentam adivinhar a **mesma palavra de 5 letras**, cada um com suas próprias tentativas (não compartilhadas), e conseguem ver o progresso um do outro em tempo real sem que as letras sejam reveladas.

**Escopo da v1:**
- Um jogador cria uma sala e recebe um ID.
- O segundo jogador entra usando esse ID.
- Os dois jogam a mesma palavra, cada um com seu próprio conjunto de tentativas.
- Cada jogador vê quantas tentativas o outro já usou (sem ver as letras).
- Quando ambos terminam (acertaram ou esgotaram as tentativas), o resultado final de ambos é revelado.

---

## 2. Regras do jogo

- Palavra secreta de **5 letras**, sorteada pelo servidor ao criar a sala.
- Cada jogador tem um número fixo de tentativas (sugestão: **6**, igual ao Wordle/Termo original).
- Feedback por letra, calculado no servidor:
  - 🟩 **Verde**: letra certa, posição certa.
  - 🟨 **Amarelo**: letra existe na palavra, posição errada.
  - ⬜ **Cinza**: letra não existe na palavra.
- As tentativas de cada jogador são **independentes**: o que o jogador A tenta não interfere no que o jogador B vê ou tenta.
- Em tempo real, cada jogador vê apenas um indicador de progresso do parceiro (ex: "seu parceiro já tentou 3/6"), nunca as letras tentadas por ele.
- Fim de partida: quando **ambos** os jogadores terminam (acertaram ou esgotaram as tentativas), o servidor revela a palavra e o resultado comparado dos dois (quem acertou, em quantas tentativas, etc).

**Decisões da implementação atual:**
- Idioma/fonte da lista de palavras (ex: dicionário PT-BR, arquivo estático `words.json` no servidor).
- Se um jogador sair durante a partida e ainda restarem 2 ou mais jogadores ativos, a partida continua normalmente.
- Se a saída deixar apenas 1 jogador ativo, a partida continua normalmente para esse jogador, sem bloqueio.
- Tempo de expiração de uma sala inativa (ex: 30 min sem atividade → sala é destruída).
- Rematch: os dois podem jogar uma nova palavra na mesma sala, ou precisam criar uma sala nova?

---

## 3. Arquitetura

```
Cliente React  <──WebSocket──>  Servidor Node.js (Fastify + ws)
                                        │
                                        ├── RoomStore (estado das salas, em memória)
                                        └── Banco de palavras (nunca exposto ao client)
```

- **Front-end**: React (SPA). Não guarda nenhum estado sensível — apenas renderiza o que o servidor manda (feedback de cores, progresso do parceiro, mensagens de erro).
- **Back-end**: Node.js com **Fastify** (HTTP mínimo, usado só para health-check e servir a conexão WS) + **`ws`** (WebSocket puro, sem Socket.io) — escolha deliberada pra manter a imagem Docker pequena e o consumo de RAM baixo, já que a lógica de salas aqui é simples e não precisa dos recursos extras do Socket.io.
- **Estado da sala**: módulo `RoomStore` com uma interface bem definida (`create`, `get`, `update`, `delete`), implementado inicialmente em memória (`Map`). Isso permite trocar por Redis depois sem reescrever a lógica do jogo — importante porque cada deploy via CI/CD reinicia o processo, e sem persistência externa isso derruba partidas em andamento.
- **Palavra secreta**: vive só no servidor, dentro do estado da sala. O client nunca recebe a palavra em nenhuma mensagem — nem em erro, nem em debug, nem em fim de jogo prematuro. Ela só é enviada quando a partida termina oficialmente (ambos terminaram).

### Por que a palavra nunca vaza
Toda validação de tentativa acontece no servidor: o client manda o palpite (string de 5 letras), o servidor compara com a palavra armazenada e devolve **apenas o array de feedback** (verde/amarelo/cinza por posição). Isso é o que garante que inspecionar a página/tráfego de rede não revele a palavra antes da hora.

---

## 4. Protocolo WebSocket

Formato sugerido: mensagens JSON com um campo `type` e um `payload`.

### Cliente → Servidor

| type | payload | descrição |
|---|---|---|
| `create_room` | `{ playerName }` | Cria uma sala nova, sorteia a palavra, retorna o `roomId` |
| `join_room` | `{ roomId, playerName }` | Entra em uma sala existente |
| `guess` | `{ roomId, word }` | Envia uma tentativa de 5 letras |
| `leave_room` | `{ roomId }` | Sai da sala |

### Servidor → Cliente

| type | payload | descrição |
|---|---|---|
| `room_created` | `{ roomId }` | Confirma criação da sala |
| `player_joined` | `{ playerName }` | Avisa que o parceiro entrou |
| `guess_result` | `{ feedback: ["green","yellow","gray",...], attemptsUsed, attemptsLeft }` | Resultado da própria tentativa |
| `opponent_progress` | `{ attemptsUsed }` | Progresso do parceiro (sem letras) |
| `game_over` | `{ word, you: {won, attempts}, opponent: {won, attempts} }` | Resultado final, revelado só quando os dois terminam |
| `error` | `{ message, code }` | Erros (sala não existe, sala cheia, palpite inválido etc) |

---

## 5. Estrutura de pastas sugerida

```
termo-multiplayer/
├── client/                    # App React
│   ├── src/
│   └── Dockerfile
├── server/                    # Node.js + Fastify + ws
│   ├── src/
│   │   ├── rooms/
│   │   │   ├── RoomStore.js       # interface abstrata
│   │   │   └── InMemoryRoomStore.js
│   │   ├── game/
│   │   │   ├── wordList.js        # lista de palavras (nunca importada no client)
│   │   │   └── gameLogic.js       # cálculo do feedback verde/amarelo/cinza
│   │   ├── ws/
│   │   │   └── handlers.js        # roteamento das mensagens WS
│   │   └── server.js
│   └── Dockerfile
├── docker-compose.yml
├── .github/
│   └── workflows/
│       └── ci-cd.yml
└── README.md
```

---

## 6. Docker

Objetivo: subir o projeto inteiro (client + server) em qualquer máquina com um único comando.

**`server/Dockerfile`** (exemplo, multi-stage pra manter a imagem enxuta):

```dockerfile
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

**`client/Dockerfile`** (build estático servido por nginx):

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

**`docker-compose.yml`** (raiz do projeto):

```yaml
services:
  server:
    build: ./server
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped

  client:
    build: ./client
    ports:
      - "8080:80"
    depends_on:
      - server
    restart: unless-stopped
```

Com isso, `docker compose up -d` sobe tudo em qualquer VM que tenha Docker instalado — sem precisar instalar Node, dependências etc na máquina de destino.

> Quando você decidir o host definitivo (Render, Cloud Run, VM própria), pode ser necessário ajustar variáveis de ambiente (porta, URL do WebSocket) — deixamos isso genérico por enquanto.

---

## 7. CI/CD com GitHub Actions

Pipeline sugerido, disparado a cada push na branch `main`:

1. **Lint & testes** — roda `npm run lint` e `npm test` em client e server.
2. **Build das imagens Docker** — build de `client` e `server`.
3. **Push para um registry** — GitHub Container Registry (ghcr.io), sem custo extra.
4. **Deploy** — passo genérico (via SSH na VM rodando `docker compose pull && docker compose up -d`, ou via webhook, dependendo de onde for hospedar).

**`.github/workflows/ci-cd.yml`** (esqueleto):

```yaml
name: CI/CD

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: cd server && npm ci && npm test
      - run: cd client && npm ci && npm run build

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: ./server
          push: true
          tags: ghcr.io/${{ github.repository }}/server:latest
      - uses: docker/build-push-action@v5
        with:
          context: ./client
          push: true
          tags: ghcr.io/${{ github.repository }}/client:latest

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Deploy na VM via SSH
        # Placeholder — ajustar quando o host for definido.
        # Ex: usar appleboy/ssh-action pra rodar `docker compose pull && docker compose up -d` na VM.
        run: echo "Configurar passo de deploy quando o host estiver definido"
```

Quando você decidir o host (Render, Cloud Run, VM própria), o passo `deploy` muda:
- **VM própria**: SSH + `docker compose pull && up -d`.
- **Render/Cloud Run**: normalmente basta o push da imagem — a plataforma redeploya automaticamente, ou você chama a API deles nesse último passo.

---

## 8. Roadmap

- **v1**: sala com 2 jogadores, uma palavra, tentativas independentes, progresso em tempo real, resultado final.
- **v2**: reconexão (se o jogador cai a internet, volta pra mesma sala sem perder o progresso), rematch na mesma sala, Redis para o `RoomStore`.
- **v3**: histórico de partidas, ranking entre duplas, múltiplos idiomas/dicionários.
