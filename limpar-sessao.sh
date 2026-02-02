#!/bin/bash
echo "Parando o bot (se estiver rodando com PM2)..."
pm2 stop evoluxrh-diamond-bot 2>/dev/null

echo ""
echo "Apagando pasta .wwebjs_auth..."
if [ -d ".wwebjs_auth" ]; then
  rm -rf .wwebjs_auth
  echo "Pasta .wwebjs_auth apagada com sucesso!"
else
  echo "Pasta .wwebjs_auth não encontrada."
fi

echo ""
echo "Pronto! Inicie o bot de novo (npm start ou pm2 start) e escaneie o novo QR Code."
