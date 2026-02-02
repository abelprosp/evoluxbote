# Biblioteca WhatsApp (whatsapp-web.js)

## Versão atual: fork com hotfix para evento "ready"

O projeto usa o **fork do Julzk** (branch `jkr_hotfix_7`) porque o pacote oficial às vezes **não dispara o evento "ready"** ao restaurar sessão salva (LocalAuth). Esse fork corrige isso.

- Repositório do fork: https://github.com/Julzk/whatsapp-web.js (branch `jkr_hotfix_7`)

## Se quiser voltar ao pacote oficial

No `package.json`, troque:

```json
"whatsapp-web.js": "https://github.com/Julzk/whatsapp-web.js/tarball/jkr_hotfix_7"
```

por:

```json
"whatsapp-web.js": "1.34.6"
```

Depois rode: `npm install`

## Após mudar a lib

1. Apague a sessão: pasta `.wwebjs_auth` (use `limpar-sessao.bat` ou `limpar-sessao.sh`)
2. Reinicie o bot e escaneie o QR Code de novo
