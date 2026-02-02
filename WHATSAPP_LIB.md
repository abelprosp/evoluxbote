# Biblioteca WhatsApp (whatsapp-web.js)

## Versão atual: fork Julzk (jkr_hotfix_7)

O projeto usa o **fork do Julzk** (branch `jkr_hotfix_7`) para corrigir o bug em que o evento **"ready"** não dispara com sessão salva. Sem o "ready" real, a biblioteca **não entrega eventos de mensagem** e o bot não responde.

**Importante:** para o bot responder às mensagens, faça **sessão nova** antes de iniciar:

1. Pare o bot.
2. Apague **`.wwebjs_auth`** e **`.wwebjs_cache`** (use `limpar-sessao.bat` ou `limpar-sessao.sh`).
3. Inicie o bot e **escaneie o novo QR Code**.
4. Aguarde aparecer **"Cliente WhatsApp conectado e pronto!"** (pode ser pelo evento "ready" ou pelo fallback de 25s).
5. Teste enviando mensagem **de outro número** (não do mesmo que escaneou o QR).

Se ainda não responder, confira nos logs se aparece **"📩 Evento de mensagem recebido"** quando alguém manda msg. Se **não** aparecer, a biblioteca ainda não está entregando mensagens (tente limpar de novo e escanear outro QR).

## Voltar ao pacote oficial

No `package.json`, troque:

```json
"whatsapp-web.js": "https://github.com/Julzk/whatsapp-web.js/tarball/jkr_hotfix_7"
```

por:

```json
"whatsapp-web.js": "1.34.6"
```

Depois rode `npm install`, apague `.wwebjs_auth` e `.wwebjs_cache` e reinicie.
