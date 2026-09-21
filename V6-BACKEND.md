# Champions Amigos V6 — Banco e Backend

Implementação inicial da V6 focada no modelo de dados e API. O frontend V5 permanece preservado nesta etapa.

## Modelo V6
- `players`: identidade permanente do jogador.
- `participations`: vínculo jogador ↔ campeonato ↔ time.
- `championships`: competição/edição e configuração do formato.
- `phases`: fases independentes da competição.
- `teams`: time do jogador dentro de uma edição.
- `matches`: partidas vinculadas a uma fase.
- `titles`: histórico permanente de títulos.
- `notifications` e `celebrationViews`: mantidos.

## Formatos
- `league`: Liga.
- `league_knockout`: Liga + Mata-mata.
- `groups_knockout`: Grupos + Mata-mata.
- `knockout`: Mata-mata direto.

## Rotas novas principais
- `PUT /api/championships/:cid` — editar campeonato.
- `POST /api/championships/:cid/finish` — finalizar manualmente, com ou sem campeão.
- `POST /api/championships/:cid/advance` — avançar fase do mata-mata.
- `GET /api/championships/:cid/bracket` — bracket/fases.
- `GET /api/players` — jogadores reutilizáveis pelo ADM.
- `GET /api/titles` — títulos do jogador logado.
- `GET /api/players/:pid/history` — histórico do jogador.
- `POST /api/championships/:cid/teams` — adiciona jogador/time à edição.
- `DELETE /api/championships/:cid/teams/:tid` — remove participante durante inscrição.

## Regra de título
Um título só é gravado em `titles` quando existe um campeão real. Encerrar manualmente sem campeão não cria título.

## Observação
Esta etapa ainda não redesenha a interface. O próximo passo é conectar o frontend V5 às novas capacidades do backend e criar as telas de formatos, fases, bracket, edição, finalização e histórico.
