/**
 * Persiste estado do funil/candidatura do webhook entre invocações (ex.: Vercel serverless).
 * Sem isso, cada mensagem pode rodar em um lambida limpo e a sessão em memória some antes do PDF.
 */
const { getSupabase } = require('../db/supabase');
const { cfg } = require('../config');

function useSupabasePersistence() {
  const raw = (process.env.WEBHOOK_SESSION_PERSISTENCE || cfg.WEBHOOK_SESSION_PERSISTENCE || '').toLowerCase();
  if (raw === 'memory' || raw === 'false' || raw === '0') return false;
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) return false;
  return true;
}

/** Remove Buffer (não serializa em JSON). Mantém apenas base64 do arquivo. */
function sanitizeSessionForDb(session) {
  if (!session || typeof session !== 'object') return session;
  const copy = JSON.parse(JSON.stringify(session));
  if (copy.resume && copy.resume.buffer != null) {
    delete copy.resume.buffer;
  }
  return copy;
}

/** Recria Buffer a partir do base64 salvo. */
function hydrateSessionResumeBuffers(session) {
  if (!session?.resume?.base64) return session;
  try {
    session.resume.buffer = Buffer.from(session.resume.base64, 'base64');
  } catch (_) {}
  return session;
}

async function loadWebhookChatState(chatId) {
  if (!useSupabasePersistence() || !chatId) {
    return { applicationSession: null, funnelAwaitingClassification: false };
  }
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('whatsapp_bot_state')
      .select('application_session, funnel_awaiting_classification')
      .eq('chat_id', chatId)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      console.warn('[WebhookSession] load:', error.message);
      return { applicationSession: null, funnelAwaitingClassification: false };
    }

    let applicationSession = data?.application_session || null;
    if (applicationSession && typeof applicationSession === 'object') {
      applicationSession = hydrateSessionResumeBuffers(applicationSession);
    }

    return {
      applicationSession,
      funnelAwaitingClassification: !!data?.funnel_awaiting_classification,
    };
  } catch (e) {
    console.warn('[WebhookSession] load falhou:', e?.message || e);
    return { applicationSession: null, funnelAwaitingClassification: false };
  }
}

async function saveWebhookChatState(chatId, applicationSession, funnelAwaitingClassification) {
  if (!useSupabasePersistence() || !chatId) return;

  try {
    const supabase = getSupabase();
    const sanitized = applicationSession ? sanitizeSessionForDb(applicationSession) : null;

    const { error } = await supabase.from('whatsapp_bot_state').upsert(
      {
        chat_id: chatId,
        application_session: sanitized,
        funnel_awaiting_classification: !!funnelAwaitingClassification,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'chat_id' }
    );

    if (error) {
      console.warn('[WebhookSession] save:', error.message);
      if (error.message && /relation|does not exist|table/i.test(error.message)) {
        console.warn('[WebhookSession] Crie a tabela executando supabase/whatsapp_bot_state.sql no SQL Editor.');
      }
    }
  } catch (e) {
    console.warn('[WebhookSession] save falhou:', e?.message || e);
  }
}

async function clearWebhookChatState(chatId) {
  if (!useSupabasePersistence() || !chatId) return;
  try {
    const supabase = getSupabase();
    await supabase.from('whatsapp_bot_state').delete().eq('chat_id', chatId);
  } catch (e) {
    console.warn('[WebhookSession] clear falhou:', e?.message || e);
  }
}

module.exports = {
  useSupabasePersistence,
  loadWebhookChatState,
  saveWebhookChatState,
  clearWebhookChatState,
};
