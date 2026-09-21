# 🏆 Champions Amigos — versão completa

Sistema web para campeonatos entre jogadores/times.

## Recursos
- Login de administrador e jogadores.
- Cadastro de campeonatos e jogadores.
- Liga única ou 2 grupos.
- Geração automática de todos os confrontos, ida e volta.
- Classificação automática com pontos, vitórias, empates, derrotas, gols e saldo.
- Jogador informa resultado e o adversário recebe a sugestão para confirmar.
- Divergência gera notificação no painel administrativo.
- Administrador pode corrigir placar e aplicar W.O.
- Tabela completa de resultados no painel ADM.
- Campeonato encerra automaticamente quando todas as partidas estão resolvidas.
- Pódio de campeão, vice e terceiro lugar.
- Destaques e zona de rebaixamento na Central do Campeonato.
- Histórico e status do campeonato.

## Requisitos
Node.js 20+ (Node 24 também funciona).

## 1. Backend
Abra um terminal:
```bash
cd server
npm install
npm run seed
npm run dev
```
Deixe esse terminal aberto.

## 2. Frontend
Abra outro terminal:
```bash
cd client
npm install
npm run dev
```
Abra a URL mostrada pelo Vite, normalmente http://localhost:5173/

## Acesso inicial
Usuário: `admin`
Senha: `admin123`

## Observação sobre atualização
Esta versão usa um banco JSON local em `server/data/database.json`. Se você já possui um banco de testes no projeto antigo, copie a pasta `server/data` antiga para esta versão se quiser preservar os campeonatos já criados. Faça uma cópia de segurança antes.


## V4 - recursos adicionados
- Excluir liga somente depois de concluída, com dupla confirmação.
- Proteção contra nomes de liga duplicados.
- Proteção contra nome de jogador duplicado dentro da mesma liga.
- Proteção contra login/usuário duplicado em todo o sistema.
- Botão para copiar o link da liga criada.
- O link inclui o identificador da liga e, após o login do jogador, abre automaticamente a liga compartilhada.


## V5 — evolução
- Tela única de login com identificação automática de ADM/participante.
- Perfil separado com alteração de nome, usuário e senha.
- Menu ⋮ com Meu perfil, alteração de acesso, exclusão e saída.
- Recuperação de senha do participante por solicitação ao ADM.
- Redefinição de senha do participante pelo ADM.
- Chave de recuperação do ADM, renovável após a configuração inicial.
- Permissões de ADM protegidas no servidor.
- Notificações de resultados, confirmações, correções e recuperação.
- Interface responsiva para celular, notebook e computador.
- Estrutura mantida sobre a V4, preservando campeonatos e recursos existentes.
