# 🔧 Por que o WhatsApp conecta mas não funciona?

Siga estes passos para descobrir o problema.

## 1. Ver os logs em tempo real

Ao enviar uma mensagem para o número do bot, você deve ver no terminal/PM2 algo como:

```
[WhatsApp] 📩 Evento de mensagem recebido de 5511999999999@c.us
[WhatsApp] 📨 Mensagem recebida de 5511999999999@c.us: "oi"
```

- **Se NÃO aparecer** `📩 Evento de mensagem recebido`: o WhatsApp Web não está recebendo mensagens (problema de conexão/sessão).
- **Se aparecer** `📩 Evento` mas depois `⏭️ Ignorado: ...`: a mensagem está sendo filtrada (veja o motivo no log).
- **Se aparecer** `📨 Mensagem recebida` e depois `✅ Resposta enviada`: está funcionando.

## 2. Bot conecta mas não responde às minhas mensagens

**Causa mais comum:** você está mandando mensagem **do mesmo número** em que o bot está conectado.

O bot ignora mensagens "enviadas por mim" (`fromMe`). Se você escaneou o QR com o seu celular e está testando mandando mensagem **desse mesmo celular** para o próprio número (ou para você mesmo), o bot vai receber e ignorar.

**Solução:** teste com **outro número**:
- Use outro celular e mande mensagem para o número do bot, ou
- Use WhatsApp e WhatsApp Business no mesmo celular: conecte o bot em um e mande mensagem do outro para esse número.

Nos logs deve aparecer: `⏭️ Ignorado: mensagem enviada por mim`.

## 3. Se não aparece nenhum evento de mensagem

- **Reconecte:** apague a pasta `.wwebjs_auth`, reinicie o bot e escaneie o QR de novo.
- **Um número por sessão:** use apenas um WhatsApp por sessão (não use o mesmo QR em outro lugar).
- **Internet:** confira se o servidor tem internet estável.
- **PM2:** veja os logs com `npm run pm2:logs` ou `pm2 logs evoluxrh-diamond-bot`.

## 4. Se aparece "Ignorado: mensagem antiga"

O bot só processa mensagens dos **últimos 30 minutos** (configurável).

No `.env` você pode aumentar:

```env
# Em milissegundos (ex.: 60 min = 3600000)
MESSAGE_MAX_AGE_MS=3600000
```

Reinicie o bot após alterar.

## 5. Se o bot está pausado

Se alguém enviou **#assumir** nessa conversa, o bot fica pausado e não responde.

Para reativar, envie no WhatsApp: **#pausa**

## 6. Conferir variáveis de ambiente

O bot precisa de:

- `OPENAI_API_KEY` (ou GROQ)
- `SUPABASE_URL`
- `SUPABASE_KEY`

Se alguma estiver faltando, o `index.js` já avisa ao iniciar. Confira o arquivo `.env` na raiz do projeto.

## 7. Testar em modo desenvolvimento

Rodar direto no terminal (sem PM2) para ver todos os logs:

```bash
npm run dev
```

Conecte o WhatsApp, espere aparecer "Cliente WhatsApp conectado e pronto!" e envie uma mensagem. Observe o que aparece no terminal.

## 8. Limpar sessão e reconectar

Se nada disso resolver:

1. Parar o bot: `pm2 stop evoluxrh-diamond-bot` (ou feche o processo).
2. Apagar a sessão:
   - Windows: `rd /s /q .wwebjs_auth`
   - Linux/Mac: `rm -rf .wwebjs_auth`
3. (Opcional) Fechar Chrome/Chromium: `taskkill /F /IM chrome.exe` (Windows) ou `pkill -f chrome` (Linux).
4. Iniciar de novo: `npm start` ou `pm2 start evoluxrh-diamond-bot`.
5. Escanear o novo QR Code com o WhatsApp (Celular: Ajustes > Aparelho conectado > Conectar um aparelho).

---

**Resumo:** O que você vê nos logs ao enviar uma mensagem?  
- Nada → problema de conexão/sessão (reconectar, ver internet/PM2).  
- "Ignorado: ..." → seguir o item correspondente acima.  
- "Mensagem recebida" + "Resposta enviada" → bot ok; se não chegar resposta no celular, pode ser atraso ou erro no envio (ver logs de erro).
