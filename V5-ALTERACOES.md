# Champions Amigos — V5

Evolução da V4, mantendo a estrutura e os recursos existentes.

## Incluído
- Login único com identificação automática de ADM/participante.
- Menu `⋮` com perfil, acesso, exclusão de conta e saída.
- Página separada de perfil.
- Participante pode alterar usuário/senha sem troca obrigatória no primeiro acesso.
- Recuperação de senha do participante via solicitação ao ADM.
- ADM pode redefinir a senha do participante.
- Chave de recuperação do ADM, criada na primeira configuração e renovável.
- Recuperação do ADM sem senha secreta embutida no sistema.
- Permissões de administrador continuam protegidas no servidor.
- Notificações para recuperação, envio/confirmação e correções de resultados.
- Interface responsiva para celular, notebook e computador.
- Recursos da V4 preservados.

## Observação
A V5 continua usando o banco JSON local da V4 (`server/data/database.json`). Faça backup desse arquivo se já houver campeonatos importantes.
