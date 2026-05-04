# 🚀 Quick Start - Docker Backend IGA Gestão

## Início Rápido em 3 passos

### 1️⃣ Construir e Iniciar

```bash
cd back-end-gest-o
docker compose up --build -d
```

Pronto! O backend está rodando em `http://localhost:3000`

### 2️⃣ Verificar Status

```bash
# Ver containers
docker compose ps

# Ver logs
docker compose logs -f backend

# Testar API
curl http://localhost:3000/health
```

### 3️⃣ Parar e Limpar

```bash
# Parar
docker compose down

# Remover tudo (volumes inclusos)
docker compose down -v
```

---

## 📋 Comandos Essenciais

| Comando | O que faz |
|---------|----------|
| `docker compose up -d` | Iniciar em background |
| `docker compose logs -f` | Ver logs em tempo real |
| `docker compose exec backend sh` | Acessar shell do container |
| `docker compose down` | Parar containers |
| `docker compose restart` | Reiniciar |
| `docker compose build --no-cache` | Reconstruir sem cache |

---

## 🔧 Configurar Variáveis de Ambiente

```bash
# Criar .env (copiar exemplo)
cp .env.example .env

# Editar conforme necessário
nano .env

# Reiniciar container
docker compose down
docker compose up -d
```

---

## 🛠️ Script Auxiliar (Linux/Mac)

```bash
# Dar permissão de execução
chmod +x docker-utils.sh

# Usar script
./docker-utils.sh build
./docker-utils.sh start
./docker-utils.sh logs
./docker-utils.sh shell
```

---

## 📚 Documentação Completa

Veja [DOCKER.md](DOCKER.md) para:
- Instruções detalhadas
- Troubleshooting
- Deploy em produção
- Performance tunning
- Exemplos avançados

---

## ✅ Checklist

- [ ] Docker e Docker Compose instalados
- [ ] `.env` configurado
- [ ] `docker compose up --build -d` executado
- [ ] `curl http://localhost:3000` retorna resposta
- [ ] `docker compose logs` mostra logs sem erro

---

**Dúvidas?** Veja a seção troubleshooting em [DOCKER.md](DOCKER.md)
