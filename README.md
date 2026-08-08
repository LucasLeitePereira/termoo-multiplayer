# Termo Multiplayer

Jogo estilo Termo em dupla: dois jogadores entram na mesma sala, tentam adivinhar a mesma palavra de 5 letras e acompanham o progresso do oponente sem ver as letras dele.

## Stack

- Client: React + Vite
- Server: Node.js + Fastify + ws
- Orquestracao local: Docker Compose

## Regras da v1

- Palavra secreta de 5 letras, sorteada no servidor.
- Cada jogador possui 6 tentativas independentes.
- Palpites aceitam qualquer palavra com exatamente 5 letras.
- A sala pode ser criada com varias rodadas (ex.: 1, 3, 5, 8).
- O criador da sala e o dono e decide quando iniciar a partida.
- A partida so pode iniciar com pelo menos 2 jogadores ativos.
- Feedback por letra: `green`, `yellow`, `gray`.
- Cada jogador ve o progresso do oponente em mini-tabuleiro com cores (sem letras).
- Cada rodada conta como finalizada com acerto ou falha.
- Vitoria do match:
  - em salas com 1 rodada, vence quem usar menos tentativas;
  - em salas com varias rodadas, vence quem concluir todas as rodadas primeiro;
  - se empatar em tentativas totais, vence quem concluir primeiro no tempo.
- Resultado final e criterio de vitoria sao revelados no `game_over`.

## Decisoes da v1

- Palavra secreta: lista estatica em [server/src/game/wordList.js](server/src/game/wordList.js).
- Saida de jogador no meio da partida: a partida continua para os jogadores restantes, inclusive se sobrar apenas 1 jogador ativo.
- Expiracao de sala inativa: 30 minutos (configuravel via `ROOM_TTL_MS`).
- Rematch: nao implementado na v1 (criar nova sala).

## Protocolo WebSocket

Formato de mensagem:

```json
{
  "type": "event_name",
  "payload": {}
}
```

### Cliente -> Servidor

- `create_room` `{ playerName, rounds }`
- `join_room` `{ roomId, playerName }`
- `start_game` `{ roomId }` (somente dono)
- `guess` `{ roomId, word }`
- `leave_room` `{ roomId }`

### Servidor -> Cliente

- `room_created`
- `room_joined`
- `player_joined`
- `player_left`
- `game_started`
- `guess_result` (inclui round, rounds, roundDone e nextRound)
- `opponent_progress` (inclui tentativas, round/roundDone e feedback por cor, sem letras do oponente)
- `game_over` (inclui resumo do vencedor e criterio)
- `opponent_left`
- `error`

## Como rodar com Docker

```bash
docker compose up -d --build
```

Acessos:

- Frontend: http://localhost:8080
- Backend health: http://localhost:3000/health

Para parar:

```bash
docker compose down
```

## Dockerfile raiz (imagem unica para deploy)

Este repositorio possui um Dockerfile principal em [Dockerfile](Dockerfile) para subir client e server no mesmo container.

Build:

```bash
docker build -t termoo-multiplayer .
```

Run:

```bash
docker run --rm -p 3000:3000 termoo-multiplayer
```

Acessos:

- App + WebSocket: http://localhost:3000
- Health: http://localhost:3000/health

No Render (Web Service com Docker):

- Dockerfile Path: `Dockerfile`
- Docker Build Context Directory: `.`

## Desenvolvimento local sem Docker

### Server

```bash
cd server
npm ci
npm run dev
```

### Client

```bash
cd client
npm ci
npm run dev
```

## Variaveis de ambiente

Client:

- `VITE_WS_URL` (opcional)
  - se nao definido, usa automaticamente mesma origem da pagina
  - em localhost com portas comuns de front (5173, 8080, 4173), usa fallback para porta 3000

Server:

- `PORT` (padrao `3000`)
- `ROOM_TTL_MS` (padrao `1800000`)

## Testes

Server possui testes basicos de logica em [server/test/gameLogic.test.js](server/test/gameLogic.test.js).

```bash
cd server
npm test
```
