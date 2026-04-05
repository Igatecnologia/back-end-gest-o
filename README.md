# IGA Backend — API de Gestao

Backend do sistema IGA. Proxy seguro para API SGBR BI, autenticacao local, CRUD de usuarios e fontes de dados.

## Stack

- Node.js 20+, Express 4, TypeScript
- Armazenamento em JSON (`data/`)
- Senhas com scrypt (zero dependencias externas)
- Proxy SGBR com auto-login e cache de token

## Instalacao

```bash
npm install
npm run dev
```

Servidor inicia em `http://localhost:3000`. Na primeira execucao cria o admin automaticamente.

## Credenciais padrao

| Email | Senha | Perfil |
|-------|-------|--------|
| admin@iga.com | admin123 | Administrador |

## Variaveis de ambiente

Copie `.env.example` para `.env`:

| Variavel | Descricao | Padrao |
|----------|-----------|--------|
| PORT | Porta do servidor | 3000 |
| FRONTEND_URL | URL do frontend (CORS) | http://localhost:5173 |
| SGBR_CREDENTIALS | login:senha da SGBR (alternativa ao datasource) | — |

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
