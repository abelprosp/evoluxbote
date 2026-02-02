#!/bin/bash
echo "Parando o bot (se estiver rodando com PM2)..."
pm2 stop evoluxrh-diamond-bot 2>/dev/null

echo ""
echo "Apagando pasta de sessão do Baileys (auth_info_baileys)..."
if [ -d "auth_info_baileys" ]; then
  rm -rf auth_info_baileys
  echo "Pasta auth_info_baileys apagada."
else
  echo "Pasta auth_info_baileys não encontrada."
fi

echo ""
echo "Pronto! Inicie o bot de novo (npm start ou pm2 start) e escaneie o novo QR Code."
