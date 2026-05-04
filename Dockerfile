# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /build

# Copiar arquivos de dependências
COPY package*.json ./
COPY tsconfig.json ./

# Instalar dependências
RUN npm ci --only=production && \
    npm ci --only=development

# Copiar código-fonte
COPY src ./src
COPY scripts ./scripts

# Compilar TypeScript
RUN npm run build

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Instalar apenas dependências de produção
COPY package*.json ./

RUN npm ci --only=production && \
    npm cache clean --force

# Copiar arquivo compilado do stage anterior
COPY --from=builder /build/dist ./dist

# Copiar arquivo de schema do banco de dados
COPY src/db/schema.sql ./src/db/

# Criar diretório para dados persistentes
RUN mkdir -p /app/data

# Variáveis de ambiente padrão
ENV NODE_ENV=production \
    PORT=3000 \
    PORT_MAX=3020

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Exposição de porta
EXPOSE 3000

# Comando de inicialização
CMD ["node", "dist/server.js"]
