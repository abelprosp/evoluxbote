-- Estado do bot no webhook (Vercel/serverless): candidatura + flag do funil de classificação.
-- Execute no SQL Editor do Supabase ou via migration.

CREATE TABLE IF NOT EXISTS whatsapp_bot_state (
  chat_id TEXT PRIMARY KEY,
  application_session JSONB,
  funnel_awaiting_classification BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_bot_state_updated ON whatsapp_bot_state(updated_at DESC);

COMMENT ON TABLE whatsapp_bot_state IS 'Sessão WhatsApp Evolution webhook: step candidatura + currículo em base64 (sem Buffer).';
