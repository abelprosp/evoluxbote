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

## 0.0 Erro 401 (sessão invalidada) / "Connection Failure" + statusCode: 401

O log mostra **statusCode: 401** e **reconectar: false**; aparece "logging in..." e depois "connection errored" / "Conexão fechada".

**Causa:** O WhatsApp **invalidou** a sessão salva em `auth_info_baileys`. Isso acontece quando:
- Você desconectou o aparelho pelo celular (Configurações > Aparelhos conectados),
- Você fez logout do WhatsApp no celular,
- A sessão expirou ou o WhatsApp a revogou por segurança.

**O que fazer:**

1. **Pare o bot** (Ctrl+C ou `pm2 stop evoluxrh-diamond-bot`).
2. **Apague a pasta** `auth_info_baileys`:
   - **Windows:** execute `limpar-sessao.bat` (ou: `rd /s /q auth_info_baileys`)
   - **Linux/Mac:** execute `./limpar-sessao.sh` (ou: `rm -rf auth_info_baileys`)
3. **Inicie o bot de novo:** `npm start` ou `pm2 start evoluxrh-diamond-bot`.
4. Quando o **QR Code** aparecer, escaneie de novo com o WhatsApp (Configurações > Aparelhos conectados > Conectar um aparelho).
5. **Não desconecte** esse aparelho pelo celular depois de escanear.

Não há como “revalidar” a sessão antiga; é preciso escanear o QR de novo.

## 0.0.0 Erro 408 (WebSocket handshake timeout) / "Opening handshake has timed out"

O log mostra **WebSocket Error (Opening handshake has timed out)** e **statusCode: 408**. O handshake com os servidores do WhatsApp não completa a tempo.

**Causas comuns:**

- **Rede lenta ou instável** (Wi‑Fi fraco, 4G com pouca cobertura).
- **Firewall ou antivírus** bloqueando conexões WebSocket (porta 443) ou domínios do WhatsApp.
- **Rede corporativa/VPN** que restringe ou inspeciona HTTPS/WebSocket.
- **Provedor de internet** com restrições ou rota ruim até os servidores do WhatsApp.

**O que fazer:**

1. **Timeout já aumentado:** O bot usa `connectTimeoutMs: 60000` (60 s). Se ainda der 408, a rede está muito lenta ou bloqueando.
2. **Testar outra rede:** Use o celular como **hotspot** ou outra conexão (casa, 4G) e rode o bot de novo.
3. **Firewall/antivírus:** Permita o Node.js e conexões para `web.whatsapp.com` e `*.whatsapp.com`. Desative temporariamente o antivírus para testar.
4. **VPN:** Se estiver em VPN, teste **desligar** ou trocar de servidor/país.
5. **VPS/servidor:** Se o bot roda em VPS, confira se o provedor não bloqueia WebSocket. Teste de outra máquina (ex.: seu PC em casa) para comparar.

Não é problema de sessão: o QR nem chega a aparecer porque a conexão inicial falha. Resolver rede/firewall costuma resolver o 408.

### 0.0.0.1 "connect ETIMEDOUT 57.x.x.x:443" (mesmo status 408)

O log mostra **WebSocket Error (connect ETIMEDOUT 57.144.179.32:443)** (o IP pode variar). Isso significa que a **conexão TCP** com o servidor do WhatsApp na porta 443 nem chega a ser estabelecida — a rede ou um firewall está **bloqueando** o acesso a esses IPs.

**O que fazer (na ordem):**

1. **Testar outra rede:** Conecte o PC ao **4G do celular (hotspot)** e rode o bot de novo. Se funcionar, o problema é a rede atual (Wi‑Fi/Provedor).
2. **Firewall do Windows:** Em "Firewall do Windows com Segurança Avançada", verifique se não há regra bloqueando **Node.js** ou conexões de saída na porta **443**. Pode criar uma regra permitindo o executável do Node (ex.: `node.exe`).
3. **Antivírus:** Muitos antivírus inspecionam ou bloqueiam conexões. Adicione uma exceção para a pasta do projeto ou para `node.exe`, ou desative temporariamente para testar.
4. **VPN:** Se você **não** usa VPN, experimente uma VPN (às vezes o provedor bloqueia WhatsApp). Se **já** usa VPN, teste **desligar** (algumas VPNs bloqueiam tráfego para certos IPs).
5. **Rede corporativa/escola:** Redes de empresa ou universidade costumam bloquear WhatsApp. Use outra rede (celular como hotspot) para o bot.

Enquanto o ETIMEDOUT persistir nessa máquina/rede, o bot não conseguirá conectar; o QR só aparece depois que a conexão com os servidores do WhatsApp é estabelecida.

**Usar proxy (alternativa):** Se você tem um proxy HTTP/HTTPS (empresa, VPN, ou serviço de proxy), pode fazer o tráfego do WhatsApp passar por ele. No `.env` adicione:

```env
BAILEYS_PROXY=http://proxy.exemplo.com:3128
```

Ou com usuário e senha (evite commitar o .env):

```env
BAILEYS_PROXY=http://usuario:senha@proxy.exemplo.com:3128
```

O bot usa a variável `HTTPS_PROXY` se `BAILEYS_PROXY` não estiver definida. Reinicie o bot após alterar. O proxy precisa permitir conexões CONNECT para `web.whatsapp.com:443`.

## 0.0.1 Erro 405 (Connection Failure) / QR não aparece

O log mostra **statusCode: 405** e **Connection Failure**; o QR Code nunca chega a aparecer.

**Causa:** O WhatsApp está rejeitando a conexão (versão desatualizada do protocolo ou bloqueio de rede/IP).

**O que fazer:**

1. O bot já usa **fetchLatestBaileysVersion()** para buscar a versão mais recente do protocolo; confira nos logs se aparece `[Baileys] Usando versão WA: x.x.x`.
2. **Apague a pasta** `auth_info_baileys` (execute `limpar-sessao.bat` ou `.sh`) e **reinicie** o bot — às vezes a sessão antiga causa 405.
3. **Teste outra rede:** use o celular como hotspot ou outra conexão. Redes corporativas ou de datacenter às vezes são bloqueadas pelo WhatsApp.
4. Se persistir, **atualize o Baileys:** `npm update @whiskeysockets/baileys` e reinicie.

## 0.0.2 Fica só no QR depois de escanear o código

Você escaneou o QR com o celular, mas a tela continua mostrando o QR e não aparece "Cliente WhatsApp conectado e pronto!".

**O que acontece:** Após escanear, o WhatsApp **desconecta** a sessão (status 515 – restartRequired) para aplicar as credenciais. O bot **reconecta em 2–3 segundos** usando a sessão salva. Às vezes os logs passam rápido e parece que travou.

**O que fazer:**

1. **Aguarde 5–10 segundos** após escanear. Deve aparecer no log:  
   `📱 QR escaneado! Salvando credenciais e reconectando (aguarde 2–3 segundos)...`  
   e depois:  
   `✅ Cliente WhatsApp (Baileys) conectado e pronto!`

2. Se **não** aparecer essa mensagem e o QR **sumir e voltar**: pode ser erro 405 na reconexão (rede/VPS). Veja o item **0.0.1 Erro 405** e teste outra rede ou limpe `auth_info_baileys` e escaneie de novo.

3. Se estiver no **VPS com PM2**: rode `pm2 logs evoluxrh-diamond-bot` e confira se, após escanear, surge "QR escaneado!" e em seguida "conectado e pronto!".

## 0.1 Bot diz "conectado e pronto" mas não responde às mensagens

1. **Teste de outro número:** envie mensagem para o número do bot a partir de **outro** celular/número (não do mesmo que escaneou o QR). O bot ignora mensagens do próprio número conectado.
2. **Confira nos logs:** quando alguém manda mensagem, deve aparecer **"📩 Evento de mensagem recebido"**. Se **não** aparecer, apague a pasta `auth_info_baileys`, reinicie o bot e escaneie o QR de novo.

## 1. Ver os logs em tempo real

Ao enviar uma mensagem para o número do bot, você deve ver no terminal/PM2 algo xwcomo:

```
[WhatsApp] 📩 Evento de mensagem recebido de 5511999999999@s.whatsapp.net
[WhatsApp] 📨 Mensagem de 5511999999999@s.whatsapp.net: "oi"
```

- **Se NÃO aparecer** `📩 Evento de mensagem recebido`: problema de conexão/sessão (reconecte, limpe `auth_info_baileys` e escaneie o QR de novo).
- **Se aparecer** `📩 Evento` mas depois `⏭️ Ignorado: ...`: a mensagem está sendo filtrada (veja o motivo no log).
- **Se aparecer** `📨 Mensagem` e depois `✅ Mensagem enviada`: está funcionando.

## 1.1 Candidatura: número "não existe" ou não encontra no banco

O telefone do candidato é obtido do **chatId** do WhatsApp (ex.: `5511999999999@s.whatsapp.net`). Antes, esse valor era salvo no banco **com** o sufixo; ao buscar por "número" (só dígitos) em outro sistema, o registro não era encontrado.

**O que foi feito:** o número passou a ser **normalizado** antes de salvar na tabela `resumes`: apenas os **dígitos** são gravados em `candidate_phone` (ex.: `5511999999999`). Assim, buscas por telefone em qualquer sistema passam a encontrar o candidato.

- Onde é salvo: tabela **resumes**, coluna **candidate_phone**.
- Momento: ao confirmar a candidatura (resposta "SIM" no fluxo do bot).
- No log aparece: `[Applications] Inserindo na tabela resumes: { candidate_name: ..., candidate_phone: 5511999999999, candidate_email: ... }`.

Se ainda aparecer "número não existe", confira se o outro sistema (site/CRM) busca pelo número **só com dígitos**, no mesmo formato (ex.: 55 + DDD + número).

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
