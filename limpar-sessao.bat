@echo off
echo Parando o bot (se estiver rodando com PM2)...
pm2 stop evoluxrh-diamond-bot 2>nul

echo.
echo Apagando pasta de sessao do Baileys (auth_info_baileys)...
if exist auth_info_baileys (
    rd /s /q auth_info_baileys
    echo Pasta auth_info_baileys apagada.
) else (
    echo Pasta auth_info_baileys nao encontrada.
)

echo.
echo Pronto! Inicie o bot de novo (npm start ou pm2 start) e escaneie o novo QR Code.
pause
