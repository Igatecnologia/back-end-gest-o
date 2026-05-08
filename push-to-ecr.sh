#!/bin/bash

set -euo pipefail

# Script de deploy para Amazon ECR
# Faz login no ECR, constrói a imagem local, cria tag e faz push.

AWS_REGION="us-east-1"
ECR_REGISTRY="838303372242.dkr.ecr.${AWS_REGION}.amazonaws.com"
ECR_REPOSITORY="repo-backend-gestao-iga-bi"
LOCAL_IMAGE="iga-gestao-backend:latest"
REMOTE_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:latest"

echo "=== AWS ECR login ==="
aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

echo "=== Build da imagem local ==="
docker build -t "${LOCAL_IMAGE}" .

echo "=== Tag para ECR ==="
docker tag "${LOCAL_IMAGE}" "${REMOTE_IMAGE}"

echo "=== Push para ECR ==="
docker push "${REMOTE_IMAGE}"

echo "\n✅ Push concluído: ${REMOTE_IMAGE}"
