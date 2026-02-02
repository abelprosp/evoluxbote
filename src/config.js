require('dotenv').config({ override: true });

function getConfig() {
  const cfg = {
    // OpenAI / GROQ / Outras APIs compatíveis
    OPENAI_API_URL: process.env.OPENAI_API_URL || process.env.GROQ_API_URL || '',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || process.env.GROQ_MODEL || 'gpt-4o-mini',
    AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS ? parseInt(process.env.AI_TIMEOUT_MS, 10) : 30000,
    AI_CHAT_PATH: process.env.AI_CHAT_PATH || '/chat/completions',
    
    // Supabase
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_KEY: process.env.SUPABASE_KEY || '',
    
    // Empresa
    COMPANY_NAME: process.env.COMPANY_NAME || 'EvoluxRH',
    COMPANY_REGISTRATION_LINK: process.env.COMPANY_REGISTRATION_LINK || 'https://evoluxrh.com/cadastro',
    TIMEZONE: process.env.TIMEZONE || 'America/Sao_Paulo',
    
    // Delays entre respostas (em milissegundos)
    RESPONSE_DELAY_MIN_MS: process.env.RESPONSE_DELAY_MIN_MS ? parseInt(process.env.RESPONSE_DELAY_MIN_MS, 10) : 2000,
    RESPONSE_DELAY_MAX_MS: process.env.RESPONSE_DELAY_MAX_MS ? parseInt(process.env.RESPONSE_DELAY_MAX_MS, 10) : 5000,
    RESPONSE_DELAY_PER_CHAR_MS: process.env.RESPONSE_DELAY_PER_CHAR_MS ? parseFloat(process.env.RESPONSE_DELAY_PER_CHAR_MS) : 50,
    MIN_DELAY_BETWEEN_MESSAGES_MS: process.env.MIN_DELAY_BETWEEN_MESSAGES_MS ? parseInt(process.env.MIN_DELAY_BETWEEN_MESSAGES_MS, 10) : 3000,
    // Idade máxima da mensagem para processar (em ms). Mensagens mais antigas são ignoradas. Padrão: 30 min
    MESSAGE_MAX_AGE_MS: process.env.MESSAGE_MAX_AGE_MS ? parseInt(process.env.MESSAGE_MAX_AGE_MS, 10) : 30 * 60 * 1000,
    // Venom: headless=false abre a janela do Chrome com o QR na tela (útil quando "Not Logged" sem QR no terminal)
    HEADLESS: process.env.HEADLESS === 'false' || process.env.HEADLESS === '0',
  };
  return cfg;
}

const cfg = getConfig();

module.exports = { cfg, getConfig };
