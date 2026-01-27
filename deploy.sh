#!/bin/bash

# Script de deploy para VPS com PM2
# Uso: ./deploy.sh [start|stop|restart|logs|status]

APP_NAME="evoluxrh-diamond-bot"
PM2_CMD="pm2"

# Cores para output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Função para verificar se PM2 está instalado
check_pm2() {
    if ! command -v $PM2_CMD &> /dev/null; then
        echo -e "${RED}❌ PM2 não está instalado!${NC}"
        echo -e "${YELLOW}Instale com: npm install -g pm2${NC}"
        exit 1
    fi
}

# Função para criar diretório de logs
create_logs_dir() {
    if [ ! -d "./logs" ]; then
        mkdir -p ./logs
        echo -e "${GREEN}✅ Diretório de logs criado${NC}"
    fi
}

# Função para verificar variáveis de ambiente
check_env() {
    if [ ! -f ".env" ]; then
        echo -e "${YELLOW}⚠️  Arquivo .env não encontrado!${NC}"
        echo -e "${YELLOW}Certifique-se de criar o arquivo .env com as variáveis necessárias${NC}"
    fi
}

# Função para instalar dependências
install_deps() {
    echo -e "${YELLOW}📦 Instalando dependências...${NC}"
    npm install
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ Dependências instaladas com sucesso${NC}"
    else
        echo -e "${RED}❌ Erro ao instalar dependências${NC}"
        exit 1
    fi
}

# Função para iniciar a aplicação
start_app() {
    echo -e "${YELLOW}🚀 Iniciando aplicação...${NC}"
    check_pm2
    create_logs_dir
    check_env
    
    # Verifica se já está rodando
    if pm2 list | grep -q "$APP_NAME"; then
        echo -e "${YELLOW}⚠️  Aplicação já está rodando${NC}"
        pm2 restart $APP_NAME
    else
        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}✅ Aplicação iniciada com sucesso!${NC}"
        echo -e "${GREEN}Use 'pm2 logs $APP_NAME' para ver os logs${NC}"
    fi
}

# Função para parar a aplicação
stop_app() {
    echo -e "${YELLOW}🛑 Parando aplicação...${NC}"
    check_pm2
    pm2 stop $APP_NAME
    echo -e "${GREEN}✅ Aplicação parada${NC}"
}

# Função para reiniciar a aplicação
restart_app() {
    echo -e "${YELLOW}🔄 Reiniciando aplicação...${NC}"
    check_pm2
    pm2 restart $APP_NAME
    echo -e "${GREEN}✅ Aplicação reiniciada${NC}"
}

# Função para ver logs
show_logs() {
    check_pm2
    pm2 logs $APP_NAME
}

# Função para ver status
show_status() {
    check_pm2
    pm2 status
    echo ""
    pm2 info $APP_NAME
}

# Função para ver informações de uso
show_usage() {
    echo -e "${YELLOW}Uso: ./deploy.sh [comando]${NC}"
    echo ""
    echo "Comandos disponíveis:"
    echo "  start     - Inicia a aplicação com PM2"
    echo "  stop      - Para a aplicação"
    echo "  restart   - Reinicia a aplicação"
    echo "  logs      - Mostra os logs em tempo real"
    echo "  status    - Mostra o status da aplicação"
    echo "  install   - Instala as dependências"
    echo "  setup     - Configuração inicial (instala deps e inicia)"
    echo ""
}

# Função de setup inicial
setup() {
    echo -e "${GREEN}🔧 Configurando aplicação...${NC}"
    install_deps
    start_app
    echo -e "${GREEN}✅ Setup concluído!${NC}"
}

# Main
case "$1" in
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    restart)
        restart_app
        ;;
    logs)
        show_logs
        ;;
    status)
        show_status
        ;;
    install)
        install_deps
        ;;
    setup)
        setup
        ;;
    *)
        show_usage
        exit 1
        ;;
esac
