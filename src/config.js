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
  };
  return cfg;
}

const cfg = getConfig();

module.exports = { cfg, getConfig };
