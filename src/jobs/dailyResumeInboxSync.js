/**
 * Job diário (somente leitura no WhatsApp): últimas N conversas Evolution →
 * recupera último PDF/imagem recebido do contato → se já existe em Supabase, ignora;
 * senão, extrai dados com IA e cadastra (sem enviar mensagem).
 *
 * Requer: EVOLUTION_*, SUPABASE_*, OPENAI_* (para extração).
 * Execução: `npm run daily:resume-sync` ou agende com SCHEDULE_DAILY_RESUME_SYNC=true no server-webhook.
 */
const { cfg } = require('../config');
const { findChats, findMessages, getBase64FromMediaMessage, getEvolutionConfig } = require('../services/evolutionService');
const { hasResumeRegisteredForPhone, saveWhatsappApplication, normalizePhoneForDb } = require('../services/applicationsService');
const { extrairDadosCurriculo } = require('../services/resumeAnalysisService');

function unwrapList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.chats)) return payload.chats;
  if (Array.isArray(payload.messages)) return payload.messages;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.records)) return payload.records;
  if (payload.response && Array.isArray(payload.response)) return payload.response;
  return [];
}

function chatRemoteJid(chat) {
  if (!chat || typeof chat !== 'object') return '';
  return (
    chat.id ||
    chat.remoteJid ||
    chat.key?.remoteJid ||
    chat.jid ||
    ''
  ).trim();
}

function chatSortTs(chat) {
  const u = chat.updatedAt || chat.update || chat.conversationTimestamp || chat.lastMsgTimestamp || chat.timestamp;
  const n = Number(u);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  return 0;
}

function isPrivateConsumerChat(jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (jid.endsWith('@g.us')) return false;
  if (jid.includes('@broadcast')) return false;
  if (jid.endsWith('@s.whatsapp.net')) return true;
  if (jid.endsWith('@lid')) return true;
  if (jid.endsWith('@c.us')) return true;
  return false;
}

function getMessageTimestamp(m) {
  const t = m?.messageTimestamp ?? m?.key?.timestamp ?? m?.timestamp;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : 0;
}

function findLastInboundResumeMessage(items) {
  const list = unwrapList(items).slice().sort((a, b) => getMessageTimestamp(b) - getMessageTimestamp(a));
  for (const item of list) {
    const key = item.key || {};
    if (key.fromMe === true) continue;
    const msg = item.message || {};
    if (msg.documentMessage || msg.imageMessage) return item;
  }
  return null;
}

function stripDataUrlBase64(b64) {
  if (typeof b64 !== 'string') return '';
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 7).trim() : b64.trim();
}

async function resolveMediaFromMessage(instance, item) {
  const msg = item.message || {};
  const doc = msg.documentMessage;
  const img = msg.imageMessage;
  const direct = doc?.base64 || img?.base64 || doc?.url?.base64 || img?.url?.base64;
  if (direct) {
    const b64 = stripDataUrlBase64(direct);
    if (b64) {
      const mimetype = doc?.mimetype || img?.mimetype || 'application/octet-stream';
      let filename = doc?.fileName || doc?.title || '';
      if (img && (!filename || !/\.(jpg|jpeg|png|webp)$/i.test(filename))) {
        const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
        filename = `curriculo.${ext}`;
      }
      if (!filename) filename = 'curriculo.pdf';
      return { base64: b64, mimetype, filename };
    }
  }

  const res = await getBase64FromMediaMessage(instance, item);
  if (!res.ok || !res.data) return null;
  const d = res.data;
  const b64 = stripDataUrlBase64(d.base64 || d?.data || (typeof d === 'string' ? d : ''));
  if (!b64) return null;
  const mimetype = doc?.mimetype || img?.mimetype || 'application/octet-stream';
  let filename = doc?.fileName || doc?.title || 'curriculo';
  if (img && (!filename || !/\.(jpg|jpeg|png|webp)$/i.test(filename))) {
    const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
    filename = `curriculo.${ext}`;
  }
  return { base64: b64, mimetype, filename };
}

/**
 * @returns {Promise<{ scanned: number, skippedRegistered: number, skippedNoMedia: number, saved: number, errors: number, details: object[] }>}
 */
async function runDailyResumeInboxSync() {
  const instance = getEvolutionConfig().instance;
  const chatLimit = cfg.DAILY_RESUME_SYNC_CHAT_LIMIT || 30;
  const msgLimit = cfg.DAILY_RESUME_SYNC_MESSAGES_LIMIT || 80;

  const summary = {
    scanned: 0,
    skippedRegistered: 0,
    skippedNoMedia: 0,
    saved: 0,
    errors: 0,
    details: [],
  };

  const chatsRes = await findChats(instance);
  if (!chatsRes.ok) {
    console.error('[DailyResumeSync] findChats falhou:', chatsRes.error);
    summary.errors++;
    return summary;
  }

  const rawChats = unwrapList(chatsRes.data);
  const withJid = rawChats.map((c) => ({ chat: c, jid: chatRemoteJid(c) })).filter((x) => isPrivateConsumerChat(x.jid));

  withJid.sort((a, b) => chatSortTs(b.chat) - chatSortTs(a.chat));
  const top = withJid.slice(0, chatLimit);

  console.log(`[DailyResumeSync] ${top.length} conversas (limite ${chatLimit}), instância: ${instance}`);

  for (const { jid } of top) {
    summary.scanned++;
    try {
      if (await hasResumeRegisteredForPhone(jid)) {
        console.log(`[DailyResumeSync] ${jid} — já cadastrado, não registra.`);
        summary.skippedRegistered++;
        summary.details.push({ jid, action: 'skip_registered' });
        await sleep(400);
        continue;
      }

      const msgRes = await findMessages(instance, jid, msgLimit);
      if (!msgRes.ok) {
        console.warn(`[DailyResumeSync] ${jid} — findMessages:`, msgRes.error);
        summary.errors++;
        summary.details.push({ jid, action: 'error_findMessages', error: msgRes.error });
        await sleep(400);
        continue;
      }

      const mediaItem = findLastInboundResumeMessage(msgRes.data);
      if (!mediaItem) {
        console.log(`[DailyResumeSync] ${jid} — sem PDF/imagem recebido do contato.`);
        summary.skippedNoMedia++;
        summary.details.push({ jid, action: 'skip_no_media' });
        await sleep(300);
        continue;
      }

      const media = await resolveMediaFromMessage(instance, mediaItem);
      if (!media?.base64) {
        console.warn(`[DailyResumeSync] ${jid} — não foi possível obter base64 da mídia.`);
        summary.skippedNoMedia++;
        summary.details.push({ jid, action: 'skip_no_base64' });
        await sleep(400);
        continue;
      }

      const buf = Buffer.from(media.base64, 'base64');
      if (!buf.length) {
        summary.skippedNoMedia++;
        summary.details.push({ jid, action: 'skip_empty_buffer' });
        await sleep(300);
        continue;
      }

      let extracted = null;
      try {
        extracted = await extrairDadosCurriculo(buf, media.mimetype);
      } catch (e) {
        console.warn(`[DailyResumeSync] ${jid} — extração IA:`, e?.message || e);
      }

      const phoneDigits = normalizePhoneForDb(extracted?.phone || jid) || normalizePhoneForDb(jid);
      if (phoneDigits && (await hasResumeRegisteredForPhone(phoneDigits))) {
        console.log(`[DailyResumeSync] ${jid} — após extração, telefone já cadastrado.`);
        summary.skippedRegistered++;
        summary.details.push({ jid, action: 'skip_registered_after_extract' });
        await sleep(400);
        continue;
      }

      await saveWhatsappApplication({
        chatId: jid,
        fullName: extracted?.fullName || 'Candidato (sync diário)',
        email: extracted?.email || null,
        whatsappNumber: phoneDigits || jid,
        city: extracted?.city || null,
        jobInterest: extracted?.jobInterest || 'Não especificado',
        resumeBase64: media.base64,
        resumeFilename: media.filename || 'curriculo.pdf',
        resumeMimetype: media.mimetype || 'application/pdf',
      });

      console.log(`[DailyResumeSync] ${jid} — cadastrado no Supabase.`);
      summary.saved++;
      summary.details.push({ jid, action: 'saved' });
    } catch (e) {
      console.error(`[DailyResumeSync] ${jid} — erro:`, e?.message || e);
      summary.errors++;
      summary.details.push({ jid, action: 'error', error: e?.message || String(e) });
    }
    await sleep(500);
  }

  console.log('[DailyResumeSync] Resumo:', summary);
  return summary;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Agenda o job no processo atual (ex.: server-webhook.js).
 * @param {string} cronExpression padrão node-cron, ex.: `15 4 * * *` = 04:15 todos os dias
 * @param {string} timeZone ex.: America/Sao_Paulo
 */
function scheduleDailyResumeInboxSync(cronExpression, timeZone) {
  const cron = require('node-cron');
  const expr = cronExpression || process.env.DAILY_RESUME_SYNC_CRON || '15 4 * * *';
  const tz = timeZone || cfg.TIMEZONE || 'America/Sao_Paulo';
  cron.schedule(
    expr,
    () => {
      runDailyResumeInboxSync().catch((err) => console.error('[DailyResumeSync] Falha agendada:', err?.message || err));
    },
    { timezone: tz }
  );
  console.log(`[DailyResumeSync] Agendado: cron "${expr}" (${tz}). Nenhuma mensagem será enviada ao WhatsApp.`);
}

module.exports = {
  runDailyResumeInboxSync,
  scheduleDailyResumeInboxSync,
};
