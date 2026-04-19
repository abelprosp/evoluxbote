/**
 * Executa uma vez o job de verificação/cadastro (últimas conversas Evolution → Supabase).
 * Agende no sistema operacional 1x/dia, ex.:
 *   Linux/macOS: crontab -e → 0 4 * * * cd /caminho/evoluxbote && npm run daily:resume-sync
 *   Windows: Agendador de Tarefas → node com argumento scripts/run-daily-resume-sync.js
 */
require('dotenv').config();

const { cfg } = require('../src/config');

async function main() {
  const need = [];
  if (!cfg.EVOLUTION_API_URL) need.push('EVOLUTION_API_URL');
  if (!cfg.EVOLUTION_API_KEY) need.push('EVOLUTION_API_KEY');
  if (!cfg.EVOLUTION_INSTANCE) need.push('EVOLUTION_INSTANCE');
  if (!cfg.SUPABASE_URL) need.push('SUPABASE_URL');
  if (!cfg.SUPABASE_KEY) need.push('SUPABASE_KEY');
  if (need.length) {
    console.error('[DailyResumeSync] Variáveis faltando:', need.join(', '));
    process.exit(1);
  }

  const { runDailyResumeInboxSync } = require('../src/jobs/dailyResumeInboxSync');
  const result = await runDailyResumeInboxSync();
  console.log('[DailyResumeSync] Concluído:', JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('[DailyResumeSync] Erro fatal:', e);
  process.exit(1);
});
