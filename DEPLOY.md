# 🚀 Guia de Deploy no VPS com PM2

Este guia explica como configurar e executar o bot EvoluxRH Diamond no seu VPS usando PM2.

## 📋 Pré-requisitos

1. **Node.js** (versão 18 ou superior)
2. **NPM** ou **Yarn**
3. **PM2** instalado globalmente
4. **Git** (para clonar o repositório)

## 🔧 Instalação Inicial

### 1. Instalar PM2 globalmente

```bash
npm install -g pm2
```

### 2. Configurar PM2 para iniciar automaticamente no boot

```bash
pm2 startup
# Siga as instruções que aparecerem no terminal
pm2 save
```

### 3. Clonar/Transferir o projeto para o VPS

```bash
# Se usar Git
git clone <seu-repositorio>
cd evoluxrh-diamond

# Ou transfira os arquivos via SCP/SFTP
```

### 4. Instalar dependências

```bash
npm install
```

### 5. Configurar variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

```env
# OpenAI / GROQ
OPENAI_API_URL=https://api.openai.com/v1
OPENAI_API_KEY=sua-chave-aqui
OPENAI_MODEL=gpt-4o-mini

# Supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_KEY=sua-chave-supabase

# Empresa (opcional)
COMPANY_NAME=EvoluxRH
COMPANY_REGISTRATION_LINK=https://evoluxrh.com/cadastro
TIMEZONE=America/Sao_Paulo
```

## 🎯 Uso do Script de Deploy

Torne o script executável:

```bash
chmod +x deploy.sh
```

### Comandos disponíveis:

```bash
# Setup inicial (instala deps e inicia)
./deploy.sh setup

# Iniciar aplicação
./deploy.sh start

# Parar aplicação
./deploy.sh stop

# Reiniciar aplicação
./deploy.sh restart

# Ver logs em tempo real
./deploy.sh logs

# Ver status da aplicação
./deploy.sh status

# Instalar apenas as dependências
./deploy.sh install
```

## 📝 Uso Direto do PM2

Se preferir usar o PM2 diretamente:

```bash
# Iniciar
pm2 start ecosystem.config.js

# Ou usando o script do package.json
npm run pm2:start

# Parar
pm2 stop evoluxrh-diamond-bot
# ou
npm run pm2:stop

# Reiniciar
pm2 restart evoluxrh-diamond-bot
# ou
npm run pm2:restart

# Ver logs
pm2 logs evoluxrh-diamond-bot
# ou
npm run pm2:logs

# Ver status
pm2 status

# Ver informações detalhadas
pm2 info evoluxrh-diamond-bot

# Monitorar recursos
pm2 monit
```

## 📊 Gerenciamento

### Ver logs

```bash
# Logs em tempo real
pm2 logs evoluxrh-diamond-bot

# Últimas 100 linhas
pm2 logs evoluxrh-diamond-bot --lines 100

# Limpar logs
pm2 flush
```

### Monitoramento

```bash
# Dashboard interativo
pm2 monit

# Status resumido
pm2 status

# Informações detalhadas
pm2 describe evoluxrh-diamond-bot
```

### Reinicialização Automática

O PM2 está configurado para:
- ✅ Reiniciar automaticamente em caso de crash
- ✅ Reiniciar após reinicialização do servidor (se configurado com `pm2 startup`)
- ✅ Limitar memória a 1GB (reinicia se exceder)
- ✅ Máximo de 10 reinicializações em 1 minuto

## 🔄 Atualizações

Para atualizar o código:

```bash
# 1. Parar a aplicação
pm2 stop evoluxrh-diamond-bot

# 2. Atualizar código (git pull, etc)
git pull

# 3. Instalar novas dependências (se houver)
npm install

# 4. Reiniciar
pm2 restart evoluxrh-diamond-bot
```

## 🐛 Troubleshooting

### Bot não inicia

1. Verifique os logs:
   ```bash
   pm2 logs evoluxrh-diamond-bot --err
   ```

2. Verifique as variáveis de ambiente:
   ```bash
   cat .env
   ```

3. Verifique se há processos Chrome/Puppeteer travados:
   ```bash
   pkill -f chrome
   ```

4. Limpe a sessão do WhatsApp (se necessário):
   ```bash
   rm -rf .wwebjs_auth
   ```

### Bot reinicia constantemente

1. Verifique os logs de erro:
   ```bash
   pm2 logs evoluxrh-diamond-bot --err
   ```

2. Verifique o uso de memória:
   ```bash
   pm2 monit
   ```

3. Aumente o limite de memória no `ecosystem.config.js` se necessário

### QR Code não aparece

1. Verifique os logs:
   ```bash
   pm2 logs evoluxrh-diamond-bot
   ```

2. Limpe a sessão antiga:
   ```bash
   pm2 stop evoluxrh-diamond-bot
   rm -rf .wwebjs_auth
   pm2 start ecosystem.config.js
   ```

3. Verifique se o servidor tem acesso gráfico ou use um túnel SSH com X11 forwarding

## 📁 Estrutura de Arquivos

```
evoluxrh-diamond/
├── ecosystem.config.js    # Configuração do PM2
├── deploy.sh              # Script de deploy
├── index.js               # Ponto de entrada
├── .env                   # Variáveis de ambiente (não commitado)
├── logs/                  # Logs do PM2 (não commitado)
│   ├── pm2-error.log
│   ├── pm2-out.log
│   └── pm2-combined.log
└── .wwebjs_auth/          # Sessão do WhatsApp (não commitado)
```

## 🔐 Segurança

- ⚠️ **NUNCA** commite o arquivo `.env`
- ⚠️ **NUNCA** commite a pasta `.wwebjs_auth`
- Use variáveis de ambiente para informações sensíveis
- Configure firewall adequadamente no VPS
- Mantenha o Node.js e dependências atualizadas

## 📞 Comandos Úteis

```bash
# Salvar configuração atual do PM2
pm2 save

# Remover aplicação do PM2
pm2 delete evoluxrh-diamond-bot

# Reiniciar todas as aplicações
pm2 restart all

# Parar todas as aplicações
pm2 stop all

# Ver estatísticas
pm2 stats
```
