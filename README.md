# IGA Backend — API de Gestao

Backend do sistema IGA. Proxy seguro para API SGBR BI, autenticacao local, CRUD de usuarios e fontes de dados.

## Stack

- Node.js 20+, Express 4, TypeScript
- Armazenamento em JSON (`data/`)
- Senhas com scrypt (zero dependencias externas)
- Proxy SGBR com auto-login e cache de token

## Como rodar o sistema completo (backend + frontend)

O IGA tem dois repositorios. Voce precisa rodar os dois para o sistema funcionar.

### Passo 1 — Clonar os repositorios

```bash
mkdir iga-gestao && cd iga-gestao
git clone https://github.com/Igatecnologia/back-end-gest-o.git
git clone https://github.com/Igatecnologia/front-end-gest-o.git
```

### Passo 2 — Iniciar o backend (este repositorio)

```bash
cd back-end-gest-o
npm install
npm run dev
```

Deve aparecer: `[IGA Backend] http://localhost:3000`

**Deixe este terminal aberto.**

### Passo 3 — Iniciar o frontend (outro terminal)

```bash
cd front-end-gest-o
npm install
npm run dev
```

### Passo 4 — Acessar

Abra **http://localhost:5173** e faca login com `admin@iga.com` / `admin123`.

Guia completo de configuracao da fonte de dados SGBR: veja o README do frontend.

---

## Instalacao somente do backend

```bash
npm install
npm run dev
```

Servidor inicia em `http://localhost:3000`. Na primeira execucao cria o admin automaticamente.

## Credenciais do sistema

| Email | Senha | Perfil |
|-------|-------|--------|
| admin@iga.com | admin123 | Administrador |

Criado automaticamente na primeira execucao. As credenciais de APIs externas sao configuradas pela tela de Fontes de Dados.
No cadastro/edicao da fonte, voce pode enviar as credenciais como:
- `authCredentials`: `"login:senha"`
- ou campos separados: `apiLogin` e `apiPassword` (o backend converte automaticamente)

## Variaveis de ambiente

Copie `.env.example` para `.env`:

| Variavel | Descricao | Padrao |
|----------|-----------|--------|
| PORT | Porta do servidor | 3000 |
| FRONTEND_URL | URL do frontend (CORS) | http://localhost:5173 |
| SGBR_CREDENTIALS | login:senha da SGBR (alternativa ao datasource) | — |

## Setup completo para novos devs (backend + frontend)

### Ordem recomendada

1. `back-end-gest-o`: `npm install` + `npm run dev`
2. Validar `http://localhost:3000/health`
3. `front-end-gest-o`: `npm install` + configurar `.env.local`
4. Garantir `VITE_API_BASE_URL=http://localhost:3000`
5. `front-end-gest-o`: `npm run dev`
6. Abrir `http://localhost:5173` e logar com `admin@iga.com / admin123`

### Checklist rapido de ambiente

- CORS liberado para `http://localhost:5173` (`FRONTEND_URL`)
- backend ativo na porta `3000`
- frontend ativo na porta `5173`
- login local funcionando em `POST /api/v1/auth/login`
- `GET /api/v1/datasources` retornando dados quando houver fonte configurada

### Problemas comuns

- **401 no login**: conferir usuario/senha admin e arquivo `data/users.json`.
- **Frontend sem dados**: conferir se o backend esta rodando e se a fonte foi cadastrada.
- **Erro de CORS**: revisar `FRONTEND_URL` no `.env` do backend e reiniciar servidor.
- **Tela "sistema nao configurado"**: normalmente `datasources` vazio para o tenant atual.

## Endpoints

### Publicos
- `GET /health` — Health check
- `POST /api/v1/auth/login` — Login (rate limit: 10/15min)
- `POST /api/v1/auth/logout` — Logout

### Autenticados (Bearer Token)
- `GET/POST/PUT/DELETE /api/v1/users` — CRUD usuarios (admin)
- `GET/POST/PUT/DELETE /api/v1/datasources` — CRUD fontes de dados
- `POST /api/v1/datasources/:id/test` — Testar conexao
- `GET /api/proxy/data` — Dados SGBR (auto-login)
- `POST /api/proxy/login` — Login SGBR
- `GET /dashboard` | `GET /reports` | `GET /audit`
- `GET /finance/*` (7 sub-rotas)
- `GET /erp/*` (9 sub-rotas)

## Estrutura

```
src/
  server.ts           — Express + rotas + seguranca
  middleware/auth.ts   — requireAuth / requireAdmin
  routes/             — 9 arquivos de rotas
  services/           — connectionTester, passwordHasher
  storage.ts          — CRUD datasources (JSON)
  userStorage.ts      — CRUD usuarios (JSON + scrypt)
  seedAdmin.ts        — Cria admin na primeira execucao
```

## Scripts

| Comando | Uso |
|---------|-----|
| npm run dev | Servidor com hot-reload (tsx watch) |
| npm run build | Compilar TypeScript |
| npm start | Iniciar build compilado |


# Login aws CLI
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 838303372242.dkr.ecr.us-east-1.amazonaws.com

# 1. Build da imagem localmente
docker build -f Dockerfile.prod -t class-tracker .

# 2. Tag para o ECR
docker tag class-tracker:latest 838303372242.dkr.ecr.us-east-1.amazonaws.com/class-tracker:latest

# 3. Push para o ECR
docker push 838303372242.dkr.ecr.us-east-1.amazonaws.com/class-tracker:latest
