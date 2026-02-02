# 🔧 Por que o WhatsApp conecta mas não funciona?

O bot usa **Baileys** (conexão direta por WebSocket, **sem browser/Puppeteer**). O QR Code aparece no terminal e em `qrcode.png`. Siga estes passos para descobrir o problema.

## 0. Precisa escanear o QR de novo / sessão inválida

Se o bot não conectar ou pedir login de novo:

1. **Pare o bot** (Ctrl+C ou `pm2 stop evoluxrh-diamond-bot`).
2. **Apague a sessão:**
   - **Windows:** execute `limpar-sessao.bat` (ou no CMD: `rd /s /q auth_info_baileys`)
   - **Linux/Mac:** execute `./limpar-sessao.sh` (ou: `rm -rf auth_info_baileys`)
3. **Inicie o bot de novo:** `npm start` ou `pm2 start evoluxrh-diamond-bot`.
4. Quando o **QR Code** aparecer no terminal (ou em `qrcode.png`), escaneie com o WhatsApp (Configurações > Aparelhos conectados > Conectar um aparelho).
5. **Não desconecte** esse aparelho pelo celular depois de escanear.

Com Baileys não há browser: o QR é gerado direto no terminal. Não existe "Not Logged" ou "desconnectedMobile" do Venom; se a sessão expirar, o Baileys reconecta ou você limpa `auth_info_baileys` e escaneia de novo.

## 0.0 Erro 405 (Connection Failure) / QR não aparece

O log mostra **statusCode: 405** e **Connection Failure**; o QR Code nunca chega a aparecer.

**Causa:** O WhatsApp está rejeitando a conexão (versão desatualizada do protocolo ou bloqueio de rede/IP).

**O que fazer:**

1. O bot já usa **fetchLatestBaileysVersion()** para buscar a versão mais recente do protocolo; confira nos logs se aparece `[Baileys] Usando versão WA: x.x.x`.
2. **Apague a pasta** `auth_info_baileys` (execute `limpar-sessao.bat` ou `.sh`) e **reinicie** o bot — às vezes a sessão antiga causa 405.
3. **Teste outra rede:** use o celular como hotspot ou outra conexão. Redes corporativas ou de datacenter às vezes são bloqueadas pelo WhatsApp.
4. Se persistir, **atualize o Baileys:** `npm update @whiskeysockets/baileys` e reinicie.

## 0.0.1 Fica só no QR depois de escanear o código

Você escaneou o QR com o celular, mas a tela continua mostrando o QR e não aparece "Cliente WhatsApp conectado e pronto!".

**O que acontece:** Após escanear, o WhatsApp **desconecta** a sessão (status 515 – restartRequired) para aplicar as credenciais. O bot **reconecta em 2–3 segundos** usando a sessão salva. Às vezes os logs passam rápido e parece que travou.

**O que fazer:**

1. **Aguarde 5–10 segundos** após escanear. Deve aparecer no log:  
   `📱 QR escaneado! Salvando credenciais e reconectando (aguarde 2–3 segundos)...`  
   e depois:  
   `✅ Cliente WhatsApp (Baileys) conectado e pronto!`

2. Se **não** aparecer essa mensagem e o QR **sumir e voltar**: pode ser erro 405 na reconexão (rede/VPS). Veja o item **0.0 Erro 405** e teste outra rede ou limpe `auth_info_baileys` e escaneie de novo.

3. Se estiver no **VPS com PM2**: rode `pm2 logs evoluxrh-diamond-bot` e confira se, após escanear, surge "QR escaneado!" e em seguida "conectado e pronto!".

## 0.1 Bot diz "conectado e pronto" mas não responde às mensagens

1. **Teste de outro número:** envie mensagem para o número do bot a partir de **outro** celular/número (não do mesmo que escaneou o QR). O bot ignora mensagens do próprio número conectado.
2. **Confira nos logs:** quando alguém manda mensagem, deve aparecer **"📩 Evento de mensagem recebido"**. Se **não** aparecer, apague a pasta `auth_info_baileys`, reinicie o bot e escaneie o QR de novo.

## 1. Ver os logs em tempo real

Ao enviar uma mensagem para o número do bot, você deve ver no terminal/PM2 algo como:

```
[WhatsApp] 📩 Evento de mensagem recebido de 5511999999999@s.whatsapp.net
[WhatsApp] 📨 Mensagem de 5511999999999@s.whatsapp.net: "oi"
```

- **Se NÃO aparecer** `📩 Evento de mensagem recebido`: problema de conexão/sessão (reconecte, limpe `auth_info_baileys` e escaneie o QR de novo).
- **Se aparecer** `📩 Evento` mas depois `⏭️ Ignorado: ...`: a mensagem está sendo filtrada (veja o motivo no log).
- **Se aparecer** `📨 Mensagem` e depois `✅ Mensagem enviada`: está funcionando.

## 2. Bot conecta mas não responde às minhas mensagens

**Causa mais comum:** você está mandando mensagem **do mesmo número** em que o bot está conectado.

O bot ignora mensagens "enviadas por mim" (`fromMe`). Teste com **outro número** (outro celular ou outro app no mesmo celular).

Nos logs deve aparecer: `⏭️ Ignorado: mensagem enviada por mim`.

## 3. Se não aparece nenhum evento de mensagem

- **Reconecte:** apague a pasta `auth_info_baileys` (execute `limpar-sessao.bat` ou `./limpar-sessao.sh`), reinicie o bot e escaneie o QR de novo.
- **Um número por sessão:** use apenas um WhatsApp por sessão.
- **Internet:** confira se o servidor tem internet estável.
- **PM2:** veja os logs com `npm run pm2:logs` ou `pm2 logs evoluxrh-diamond-bot`.

## 4. Se aparece "Ignorado: mensagem antiga"

O bot só processa mensagens dos **últimos 30 minutos** (configurável no `.env` com `MESSAGE_MAX_AGE_MS`).

## 5. Se o bot está pausado

Se alguém enviou **#assumir** nessa conversa, o bot fica pausado. Para reativar, envie no WhatsApp: **#pausa**

## 6. Conferir variáveis de ambiente

O bot precisa de: `OPENAI_API_KEY` (ou GROQ), `SUPABASE_URL`, `SUPABASE_KEY`. Confira o arquivo `.env` na raiz do projeto.

## 7. Testar em modo desenvolvimento

```bash
npm run dev
```

Espere aparecer "Cliente WhatsApp (Baileys) conectado e pronto!" e envie uma mensagem. Observe o que aparece no terminal.

## 8. Limpar sessão e reconectar (Baileys)

1. **Parar o bot:** `pm2 stop evoluxrh-diamond-bot` (ou Ctrl+C).
2. **Apagar a sessão:**
   - Windows: execute `limpar-sessao.bat` ou `rd /s /q auth_info_baileys`
   - Linux/Mac: execute `./limpar-sessao.sh` ou `rm -rf auth_info_baileys`
3. **Iniciar de novo:** `npm start` ou `pm2 start evoluxrh-diamond-bot`.
4. Escanear o **novo** QR Code com o WhatsApp (Configurações > Aparelhos conectados > Conectar um aparelho).

---

**Resumo:** Com Baileys não há browser nem "Not Logged". O QR aparece no terminal e em `qrcode.png`. Sessão fica em `auth_info_baileys`. Se algo der errado, limpe essa pasta e escaneie o QR de novo.
