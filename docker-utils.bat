@echo off
REM Script de utilidade para Docker - Backend IGA Gestão (Windows)
REM Uso: docker-utils.bat [comando]

setlocal enabledelayedexpansion

set "CONTAINER_NAME=iga-gestao-backend"
set "IMAGE_NAME=iga-gestao-backend:latest"

REM Cores (não funcionam bem em CMD, apenas para compatibilidade)
set "GREEN=[92m"
set "RED=[91m"
set "YELLOW=[93m"
set "BLUE=[94m"
set "NC=[0m"

if "%1"=="" goto help
if "%1"=="--help" goto help
if "%1"=="-h" goto help

if /i "%1"=="build" goto build
if /i "%1"=="build-nocache" goto build_nocache
if /i "%1"=="start" goto start
if /i "%1"=="start-dev" goto start_dev
if /i "%1"=="stop" goto stop
if /i "%1"=="restart" goto restart
if /i "%1"=="rebuild" goto rebuild
if /i "%1"=="logs" goto logs
if /i "%1"=="shell" goto shell
if /i "%1"=="status" goto status
if /i "%1"=="health" goto health
if /i "%1"=="test" goto test
if /i "%1"=="stats" goto stats
if /i "%1"=="clean" goto clean
if /i "%1"=="remove" goto remove

echo Comando desconhecido: %1
goto help

:build
echo === Construindo imagem Docker ===
docker build -t %IMAGE_NAME% .
echo [OK] Imagem construída com sucesso
exit /b 0

:build_nocache
echo === Construindo imagem Docker (sem cache) ===
docker build --no-cache -t %IMAGE_NAME% .
echo [OK] Imagem construída com sucesso
exit /b 0

:start
echo === Iniciando container ===
docker compose up -d
echo [OK] Container iniciado
docker compose ps
exit /b 0

:start_dev
echo === Iniciando container em modo desenvolvimento ===
docker compose up
exit /b 0

:stop
echo === Parando container ===
docker compose down
echo [OK] Container parado
exit /b 0

:restart
echo === Reiniciando container ===
docker compose restart backend
echo [OK] Container reiniciado
exit /b 0

:rebuild
echo === Reconstruindo container ===
docker compose up --build -d
echo [OK] Container reconstruído e iniciado
exit /b 0

:logs
echo === Logs do container ===
docker compose logs -f backend
exit /b 0

:shell
echo === Acessando shell do container ===
docker exec -it %CONTAINER_NAME% sh
exit /b 0

:status
echo === Status dos containers ===
docker compose ps
exit /b 0

:health
echo === Status de saúde do container ===
docker inspect %CONTAINER_NAME% --format="{{json .State.Health}}" 2>nul || (
    echo [ERRO] Container nao encontrado
    exit /b 1
)
exit /b 0

:test
echo === Executando testes ===
docker exec %CONTAINER_NAME% npm run test
exit /b 0

:stats
echo === Estatísticas de uso ===
docker stats %CONTAINER_NAME%
exit /b 0

:clean
echo === Limpando Docker ===
docker image prune -f
docker container prune -f
docker volume prune -f
echo [OK] Limpeza concluída
exit /b 0

:remove
echo === Removendo container e imagem ===
docker compose down -v
docker rmi %IMAGE_NAME% 2>nul
echo [OK] Container e imagem removidos
exit /b 0

:help
echo Docker Utils - Backend IGA Gestao (Windows)
echo.
echo Uso: %0 [comando]
echo.
echo Comandos:
echo   build              Construir imagem Docker
echo   build-nocache      Construir imagem sem cache
echo   start              Iniciar container (background)
echo   start-dev          Iniciar container em modo desenvolvimento
echo   stop               Parar container
echo   restart            Reiniciar container
echo   rebuild            Reconstruir e iniciar container
echo   logs               Visualizar logs em tempo real
echo   shell              Acessar shell do container
echo   status             Ver status dos containers
echo   health             Verificar saúde do container
echo   test               Executar testes
echo   stats              Ver uso de recursos
echo   clean              Limpar imagens e containers nao usados
echo   remove             Remover container e imagem
echo   help               Mostrar esta mensagem
echo.
echo Exemplos:
echo   %0 build
echo   %0 start
echo   %0 logs
echo   %0 shell
echo.
exit /b 0
