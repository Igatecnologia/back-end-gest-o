# Guia Docker - Backend IGA Gestão

Este documento explica como construir e executar o backend da IGA Gestão usando Docker.

## 📋 Pré-requisitos

- **Docker**: v20.10 ou superior
- **Docker Compose**: v2.0 ou superior

Para verificar suas versões:

```bash
docker --version
docker compose --version
```

## 🚀 Iniciar Rápido

### Opção 1: Docker Compose (Recomendado)

```bash
# Construir e iniciar o container
docker compose up --build

# Em modo detach (segundo plano)
docker compose up -d --build

# Visualizar logs
docker compose logs -f backend

# Parar os containers
docker compose down
```

### Opção 2: Docker Direto

```bash
# Construir a imagem
docker build -t iga-gestao-backend:latest .

# Executar o container
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  --name iga-backend \
  iga-gestao-backend:latest

# Parar o container
docker stop iga-backend
```

## 📁 Estrutura do Dockerfile

O Dockerfile usa **multi-stage build** para otimização:

### Stage 1: Builder
- Usa Node.js 22 Alpine
- Instala todas as dependências (dev + production)
- Compila o TypeScript para JavaScript

### Stage 2: Runtime
- Usa Node.js 22 Alpine (menor footprint)
- Copia apenas dependências de produção
- Copia o código compilado do stage anterior
- Reduz o tamanho final da imagem

## 🔧 Variáveis de Ambiente

Configure as seguintes variáveis no seu `.env` ou no `docker-compose.yml`:

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `NODE_ENV` | `production` | Ambiente de execução |
| `PORT` | `3000` | Porta principal do servidor |
| `PORT_MAX` | `3020` | Porta máxima para fallback |
| `CORS_ORIGIN` | - | URL do frontend para CORS |
| `DATABASE_URL` | - | URL de conexão do banco de dados |
| `LOG_LEVEL` | `info` | Nível de logging |

### Usar arquivo `.env`

```bash
# Criar arquivo .env
cat > .env << EOF
NODE_ENV=production
PORT=3000
CORS_ORIGIN=http://localhost:5173
EOF

# Passar para o container
docker run -p 3000:3000 --env-file .env iga-gestao-backend:latest
```

## 🏥 Health Check

O container inclui um health check automático que verifica a disponibilidade da API a cada 30 segundos:

```bash
# Verificar status do container
docker ps --filter "name=iga-backend"

# Visualizar historico de health checks
docker inspect iga-backend --format='{{json .State.Health}}' | jq
```

## 📊 Gerenciar Dados

### Volumes

O container cria um volume `backend_data` para dados persistentes:

```bash
# Listar volumes
docker volume ls

# Inspecionar volume
docker volume inspect iga_gestao_backend_data

# Remover volume (cuidado!)
docker volume rm iga_gestao_backend_data
```

### Banco de Dados SQLite

Se usar SQLite, o banco será armazenado no volume:

```bash
# Acessar o container e conferir o banco
docker exec iga-backend ls -la /app/data
```

## 🔍 Debug e Troubleshooting

### Ver logs
```bash
# Logs em tempo real
docker compose logs -f backend

# Últimas 100 linhas
docker compose logs --tail=100 backend

# Logs de um container específico
docker logs iga-backend
```

### Acessar o container
```bash
# Shell interativo
docker exec -it iga-backend sh

# Executar comando
docker exec iga-backend npm run test
```

### Verificar performance
```bash
# Uso de recursos
docker stats iga-backend

# Inspecionar configuração
docker inspect iga-backend
```

### Problemas Comuns

#### ❌ "Port 3000 already in use"
```bash
# Opção 1: Usar porta diferente
docker run -p 3001:3000 iga-gestao-backend:latest

# Opção 2: Parar container anterior
docker stop iga-backend
docker rm iga-backend

# Opção 3: Ver qual processo usa a porta
netstat -ano | findstr :3000  # Windows
lsof -i :3000  # macOS/Linux
```

#### ❌ "Build failed: npm ERR"
```bash
# Limpar cache
docker builder prune

# Reconstruir sem cache
docker compose build --no-cache
```

#### ❌ Container para imediatamente
```bash
# Ver logs de erro
docker compose logs backend

# Verificar entrypoint
docker inspect iga-gestao-backend:latest | grep -A 5 "Entrypoint"
```

## 🚢 Deploy em Produção

### Otimizações

1. **Usar `.env.production`** para variáveis de produção
2. **Configurar restart policy**:
   ```yaml
   restart: unless-stopped
   ```

3. **Limitar recursos**:
   ```yaml
   deploy:
     resources:
       limits:
         cpus: '1'
         memory: 512M
       reservations:
         cpus: '0.5'
         memory: 256M
   ```

4. **Usar registry privado**:
   ```bash
   docker tag iga-gestao-backend:latest registry.example.com/iga-backend:v1.0
   docker push registry.example.com/iga-backend:v1.0
   ```

### Deploy com Docker Compose

```bash
# Construir em produção
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

# Iniciar
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Visualizar
docker compose ps
```

## 📦 Tamanho da Imagem

Para verificar o tamanho:

```bash
docker images iga-gestao-backend:latest

# Exemplo de saída
# REPOSITORY                 TAG       SIZE
# iga-gestao-backend         latest    185MB
```

### Otimizações para reduzir tamanho

- Multi-stage build já aplicado ✓
- Alpine Linux já utilizado ✓
- Limpeza de cache npm ✓

## 🔐 Segurança

Recomendações implementadas:

- ✓ Usar Node.js Alpine (menor superfície de ataque)
- ✓ Multi-stage build (sem ferramentas de build na imagem final)
- ✓ Não executar como root (usar USER)

Recomendações adicionais:

```dockerfile
# Adicionar ao Dockerfile (antes do CMD)
USER node
```

## 🧪 Testar Localmente

```bash
# Build
docker build -t iga-gestao-backend:test .

# Run
docker run -p 3000:3000 \
  -e NODE_ENV=development \
  iga-gestao-backend:test

# Em outro terminal, testar
curl http://localhost:3000/health
```

## 📝 Comandos Úteis

```bash
# Remover imagem não utilizada
docker image prune

# Remover todos os containers parados
docker container prune

# Verificar imagem camada por camada
docker history iga-gestao-backend:latest

# Exportar container como tarball
docker save iga-gestao-backend:latest | gzip > backend.tar.gz

# Importar tarball
gunzip -c backend.tar.gz | docker load
```

## 📞 Suporte

Para mais informações:
- [Documentação Docker](https://docs.docker.com)
- [Documentação Node.js Docker](https://hub.docker.com/_/node)
- [Dockerfile best practices](https://docs.docker.com/develop/dev-best-practices/dockerfile_best-practices/)

## 🔄 Atualizar Imagem

```bash
# Após modificações no código
docker compose up --build -d

# Forçar rebuild sem cache
docker compose build --no-cache backend
docker compose up -d backend
```

---

**Última atualização**: Maio 2026  
**Versão Backend**: 1.2.0  
**Node.js**: 22 LTS Alpine
