@echo off
echo Parando o bot (se estiver rodando com PM2)...
pm2 stop evoluxrh-diamond-bot 2>nul

echo.
echo Apagando pasta .wwebjs_auth...
if exist .wwebjs_auth (
    rd /s /q .wwebjs_auth
    echo Pasta .wwebjs_auth apagada com sucesso!
) else (
    echo Pasta .wwebjs_auth nao encontrada.
)

echo.
echo Pronto! Inicie o bot de novo (npm start ou pm2 start) e escaneie o novo QR Code.
pause
