#!/bin/bash
# Script para atualizar o bot no VPS para a versão com Baileys (sem whatsapp-web.js)
# Execute na pasta do projeto no VPS: bash atualizar-vps-baileys.sh

set -e
echo "=== Atualizando projeto para Baileys no VPS ==="

# Nome do app no PM2 (ajuste se for diferente)
APP_NAME="${PM2_APP_NAME:-evoluxrh-diamond-bot}"

echo "1. Parando o bot..."
pm2 stop "$APP_NAME" 2>/dev/null || true

echo "2. Verificando package.json..."
if grep -q "whatsapp-web.js" package.json 2>/dev/null; then
  echo "   ERRO: package.json ainda contém whatsapp-web.js!"
  echo "   Você precisa substituir o package.json pelo da versão com Baileys."
  echo "   No package.json, deve ter: \"@whiskeysockets/baileys\" e NÃO \"whatsapp-web.js\""
  exit 1
fi
if ! grep -q "@whiskeysockets/baileys" package.json 2>/dev/null; then
  echo "   ERRO: package.json não contém @whiskeysockets/baileys!"
  echo "   Atualize os arquivos do projeto (git pull ou upload) antes de rodar este script."
  exit 1
fi
echo "   OK: package.json correto (Baileys)."

echo "3. Removendo node_modules e package-lock.json..."
rm -rf node_modules package-lock.json

echo "4. Instalando dependências (Baileys)..."
npm install

echo "5. Removendo pastas de sessão antigas (whatsapp-web.js / Venom)..."
rm -rf .wwebjs_auth .wwebjs_cache tokens

echo "6. Iniciando o bot..."
pm2 start ecosystem.config.js 2>/dev/null || pm2 start index.js --name "$APP_NAME"

echo ""
echo "=== Pronto! Verifique os logs: pm2 logs $APP_NAME ==="
echo "Se aparecer [Baileys] ou 'Usando versão WhatsApp Web', está rodando a versão nova."
echo "Se ainda aparecer LocalWebCache ou whatsapp-web.js, o código no servidor não foi atualizado."
