const { createClient } = require('@supabase/supabase-js');
const { cfg } = require('../config');

let supabase;

function getSupabase() {
  if (!supabase) {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
      throw new Error('Supabase não configurado: defina SUPABASE_URL e SUPABASE_KEY no .env');
    }
    supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

module.exports = { getSupabase };
