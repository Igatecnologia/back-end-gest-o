#!/bin/bash

# Script de utilidade para Docker - Backend IGA Gestão
# Uso: ./docker-utils.sh [comando]

set -e

CONTAINER_NAME="iga-gestao-backend"
IMAGE_NAME="iga-gestao-backend:latest"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Funções auxiliares
print_header() {
    echo -e "${BLUE}=== $1 ===${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

# Funções de comando
build() {
    print_header "Construindo imagem Docker"
    docker build -t $IMAGE_NAME .
    print_success "Imagem construída com sucesso"
}

build_nocache() {
    print_header "Construindo imagem Docker (sem cache)"
    docker build --no-cache -t $IMAGE_NAME .
    print_success "Imagem construída com sucesso"
}

start() {
    print_header "Iniciando container"
    docker compose up -d
    print_success "Container iniciado"
    docker compose ps
}

start_dev() {
    print_header "Iniciando container em modo desenvolvimento"
    docker compose -f docker-compose.yml -f docker-compose.dev.yml up
}

stop() {
    print_header "Parando container"
    docker compose down
    print_success "Container parado"
}

logs() {
    print_header "Logs do container"
    docker compose logs -f backend
}

shell() {
    print_header "Acessando shell do container"
    docker exec -it $CONTAINER_NAME sh
}

test() {
    print_header "Executando testes"
    docker exec $CONTAINER_NAME npm run test
}

health() {
    print_header "Status de saúde do container"
    docker inspect $CONTAINER_NAME --format='{{json .State.Health}}' | jq .
}

status() {
    print_header "Status dos containers"
    docker compose ps
}

clean() {
    print_header "Limpando Docker"
    docker image prune -f
    docker container prune -f
    docker volume prune -f
    print_success "Limpeza concluída"
}

restart() {
    print_header "Reiniciando container"
    docker compose restart backend
    print_success "Container reiniciado"
}

rebuild() {
    print_header "Reconstruindo container"
    docker compose up --build -d
    print_success "Container reconstruído e iniciado"
}

stats() {
    print_header "Estatísticas de uso"
    docker stats $CONTAINER_NAME
}

remove() {
    print_header "Removendo container e imagem"
    docker compose down -v
    docker rmi $IMAGE_NAME
    print_success "Container e imagem removidos"
}

logs_json() {
    print_header "Logs em formato JSON"
    docker compose logs backend --tail=50 -t --no-color | jq -R 'fromjson?' 2>/dev/null || docker compose logs backend --tail=50
}

# Menu de ajuda
show_help() {
    cat << EOF
${BLUE}Docker Utils - Backend IGA Gestão${NC}

Uso: $0 [comando]

${BLUE}Comandos:${NC}
  build              Construir imagem Docker
  build-nocache      Construir imagem sem cache
  start              Iniciar container (background)
  start-dev          Iniciar container em modo desenvolvimento (foreground)
  stop               Parar container
  restart            Reiniciar container
  rebuild            Reconstruir e iniciar container
  logs               Visualizar logs em tempo real
  logs-json          Visualizar logs em JSON
  shell              Acessar shell do container
  status             Ver status dos containers
  health             Verificar saúde do container
  test               Executar testes
  stats              Ver uso de recursos
  clean              Limpar imagens e containers não usados
  remove             Remover container e imagem
  help               Mostrar esta mensagem

${BLUE}Exemplos:${NC}
  $0 build
  $0 start
  $0 logs
  $0 shell

EOF
}

# Executar comando
case "${1:-help}" in
    build)
        build
        ;;
    build-nocache)
        build_nocache
        ;;
    start)
        start
        ;;
    start-dev)
        start_dev
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    rebuild)
        rebuild
        ;;
    logs)
        logs
        ;;
    logs-json)
        logs_json
        ;;
    shell)
        shell
        ;;
    status)
        status
        ;;
    health)
        health
        ;;
    test)
        test
        ;;
    stats)
        stats
        ;;
    clean)
        clean
        ;;
    remove)
        remove
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        print_error "Comando desconhecido: $1"
        show_help
        exit 1
        ;;
esac
