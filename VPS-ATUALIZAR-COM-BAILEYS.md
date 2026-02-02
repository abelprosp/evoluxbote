# ⚠️ VPS ainda com código antigo (whatsapp-web.js)

Se no VPS aparece **LocalWebCache** ou **whatsapp-web.js** no erro, o servidor está com a **versão antiga** do projeto. É preciso **subir o código novo (Baileys)** para o VPS e reinstalar as dependências.

---

## Por que o erro continua?

O caminho do erro é:  
`/root/evoluxbote/node_modules/whatsapp-web.js`

Isso só existe se no VPS estiver instalado **whatsapp-web.js**. O projeto atual usa **Baileys** e **não** usa whatsapp-web.js. Ou seja: **os arquivos que estão em /root/evoluxbote no VPS ainda são os antigos.**

---

## O que fazer (escolha uma opção)

### Opção A: Você usa Git

1. **No seu PC** (onde está o projeto com Baileys):
   - Confirme que `package.json` tem `@whiskeysockets/baileys` e **não** tem `whatsapp-web.js`.
   - Faça commit e push:
     ```bash
     git add .
     git commit -m "Migração para Baileys"
     git push
     ```

2. **No VPS** (SSH em `/root/evoluxbote`):
   ```bash
   cd /root/evoluxbote
   pm2 stop evoluxrh-diamond-bot
   pm2 stop evoluxrh
   git pull
   grep "whatsapp-web" package.json && echo "ERRO: package.json ainda tem whatsapp-web! O git pull não trouxe a versão nova." || echo "OK: package.json sem whatsapp-web"
   grep "baileys" package.json && echo "OK: Baileys no package.json" || echo "ERRO: Baileys não está no package.json!"
   rm -rf node_modules package-lock.json
   npm install
   rm -rf .wwebjs_auth .wwebjs_cache tokens auth_info_baileys
   pm2 start ecosystem.config.js
   pm2 logs
   ```

   Se o `grep` mostrar **ERRO**, o repositório remoto não está atualizado. Atualize o repo no PC e faça push de novo, depois `git pull` no VPS outra vez.

---

### Opção B: Você NÃO usa Git (sobe arquivos manualmente)

1. **No seu PC**: a pasta do projeto (evoluxrh-diamond) já está com Baileys. Você precisa **enviar essa pasta inteira** para o VPS, **substituindo** a que está em `/root/evoluxbote`.

2. **Como enviar** (um jeito com SCP, no PowerShell ou CMD do PC):
   ```bash
   scp -r "C:\Users\computador Artur\Desktop\clientes\evolux\bote\evoluxrh-diamond\*" root@IP_DO_SEU_VPS:/root/evoluxbote/
   ```
   (Troque `IP_DO_SEU_VPS` pelo IP do servidor. Se usar outro usuário que não `root`, troque `root` também.)

   Ou use **FileZilla / WinSCP**: conecte no VPS e arraste a pasta do projeto do PC para `/root/evoluxbote`, sobrescrevendo os arquivos.

3. **No VPS**, depois de copiar os arquivos:
   ```bash
   cd /root/evoluxbote
   pm2 stop evoluxrh-diamond-bot
   pm2 stop evoluxrh
   cat package.json | grep -E "whatsapp-web|baileys"
   ```
   - Deve **aparecer** algo com `baileys`.
   - **Não** deve aparecer `whatsapp-web`.

   Se ainda aparecer whatsapp-web, a cópia não substituiu o `package.json`; copie de novo.

   ```bash
   rm -rf node_modules package-lock.json
   npm install
   rm -rf .wwebjs_auth .wwebjs_cache tokens auth_info_baileys
   pm2 start ecosystem.config.js
   pm2 logs
   ```

---

## Como saber se deu certo

Depois de `pm2 start` e `pm2 logs`:

- **Certo:** nos logs aparece `[Baileys]`, `Usando versão WhatsApp Web` ou `Iniciando Baileys`. **Não** aparece mais `LocalWebCache` nem `whatsapp-web.js`.
- **Errado:** ainda aparece `whatsapp-web.js` ou `LocalWebCache` → os arquivos no VPS continuam antigos. Repita a Opção A ou B e confira o `package.json` no VPS.

---

## Resumo

| Onde está o código novo (Baileys)? | O que fazer no VPS |
|------------------------------------|---------------------|
| No seu PC (pasta evoluxrh-diamond) | Opção B: copiar essa pasta para o VPS e rodar os comandos acima. |
| No Git (repositório atualizado)    | Opção A: no VPS dar `git pull`, depois `rm -rf node_modules`, `npm install`, `pm2 restart`. |

O erro **só some** quando em `/root/evoluxbote` não existir mais `node_modules/whatsapp-web.js`. Isso acontece quando o **código** no VPS for o novo (com Baileys) e você rodar **npm install** de novo.
