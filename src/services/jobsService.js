const { getSupabase } = require('../db/supabase');

let _cache = { data: [], ts: 0 };

async function getActiveJobs() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .select('id,title,location,description,is_active')
    .eq('is_active', true);
  if (error) throw new Error(`SupabaseError: ${error.message}`);
  return data || [];
}

async function getActiveJobsCached(limit = 5, ttlMs = 30000) {
  const fresh = Date.now() - _cache.ts < ttlMs;
  if (fresh && _cache.data?.length) {
    return _cache.data.slice(0, limit);
  }
  const data = await getActiveJobs();
  _cache = { data, ts: Date.now() };
  return _cache.data.slice(0, limit);
}

function summarizeJobs(jobs) {
  if (!jobs?.length) return 'Nenhuma vaga ativa encontrada no momento.';
  const lines = jobs.map((j) => {
    const loc = j.location ? ` (${j.location})` : '';
    const descSrc = j.description ? String(j.description) : '';
    const desc = descSrc ? ` - ${descSrc.slice(0, 100)}${descSrc.length > 100 ? '...' : ''}` : '';
    return `- ${j.title}${loc}${desc}`;
  });
  return `Vagas ativas:
${lines.join('\n')}`;
}

module.exports = { getActiveJobs, getActiveJobsCached, summarizeJobs };
