/**
 * Serviço para enviar mensagens via Evolution API.
 * Usado quando o bot roda como API na Vercel (webhook) em vez de Baileys direto.
 */
const axios = require('axios');
const { cfg } = require('../config');

function getEvolutionConfig() {
  const baseUrl = (cfg.EVOLUTION_API_URL || process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  const apiKey = cfg.EVOLUTION_API_KEY || process.env.EVOLUTION_API_KEY || '';
  const instance = cfg.EVOLUTION_INSTANCE || process.env.EVOLUTION_INSTANCE || '';
  return { baseUrl, apiKey, instance };
}

/**
 * Extrai o número do remoteJid para usar no body da Evolution API.
 * Ex: "5598987654321@s.whatsapp.net" -> "5598987654321"
 */
function jidToNumber(remoteJid) {
  if (!remoteJid || typeof remoteJid !== 'string') return '';
  return remoteJid.replace(/@.*$/, '').trim();
}

/**
 * Envia mensagem de texto via Evolution API.
 * @param {string} instance - Nome da instância (usa cfg se não informado)
 * @param {string} numberOrJid - Número com DDD ou remoteJid (ex: 5598987654321 ou 5598987654321@s.whatsapp.net)
 * @param {string} text - Texto da mensagem
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
async function sendText(instance, numberOrJid, text) {
  const { baseUrl, apiKey, instance: defaultInstance } = getEvolutionConfig();
  const inst = instance || defaultInstance;
  const number = jidToNumber(numberOrJid) || numberOrJid;

  if (!baseUrl || !apiKey || !inst) {
    console.error('[Evolution] Configuração incompleta: EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE');
    return { success: false, error: 'Evolution API não configurada' };
  }

  const url = `${baseUrl}/message/sendText/${inst}`;
  try {
    const { data, status } = await axios.post(
      url,
      { number, text },
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: apiKey,
        },
        timeout: 30000,
      }
    );
    if (status >= 200 && status < 300) {
      return { success: true, data };
    }
    return { success: false, error: data?.message || `HTTP ${status}` };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || String(err);
    console.error('[Evolution] Erro ao enviar mensagem:', msg);
    return { success: false, error: msg };
  }
}

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    apikey: apiKey,
  };
}

/**
 * Lista conversas da instância (Evolution API).
 * v2 documentação: POST /chat/findChats/{instance}; v1 costumava responder em GET — tentamos POST primeiro.
 * @returns {Promise<{ ok: boolean, data?: unknown, error?: string }>}
 */
async function findChats(instance) {
  const { baseUrl, apiKey, instance: defaultInstance } = getEvolutionConfig();
  const inst = encodeURIComponent(instance || defaultInstance);
  if (!baseUrl || !apiKey || !inst) {
    return { ok: false, error: 'Evolution API não configurada' };
  }
  const root = baseUrl.replace(/\/$/, '');
  const url = `${root}/chat/findChats/${inst}`;
  try {
    let status;
    let data;

    try {
      const res = await axios.post(url, {}, { headers: buildHeaders(apiKey), timeout: 120000 });
      status = res.status;
      data = res.data;
    } catch (first) {
      const code = first.response?.status;
      if (code === 404 || code === 405 || code === 501) {
        console.warn('[Evolution] findChats POST falhou (%s); tentando GET (API v1 ou proxy).', code);
        const res = await axios.get(url, { headers: buildHeaders(apiKey), timeout: 120000 });
        status = res.status;
        data = res.data;
      } else {
        throw first;
      }
    }

    if (status >= 200 && status < 300) return { ok: true, data };
    return { ok: false, error: data?.message || `HTTP ${status}` };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || String(err);
    const status = err.response?.status;
    console.error('[Evolution] findChats:', msg, status ? `(HTTP ${status})` : '');
    return { ok: false, error: msg };
  }
}

/**
 * Busca mensagens de um chat (Evolution API).
 * @param {string} remoteJid ex: 5598...@s.whatsapp.net
 */
async function findMessages(instance, remoteJid, limit = 80) {
  const { baseUrl, apiKey, instance: defaultInstance } = getEvolutionConfig();
  const inst = encodeURIComponent(instance || defaultInstance);
  if (!baseUrl || !apiKey || !inst || !remoteJid) {
    return { ok: false, error: 'Evolution API não configurada ou remoteJid vazio' };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/chat/findMessages/${inst}`;
  const body = {
    where: { key: { remoteJid } },
    limit,
  };
  try {
    const { data, status } = await axios.post(url, body, {
      headers: buildHeaders(apiKey),
      timeout: 120000,
    });
    if (status >= 200 && status < 300) return { ok: true, data };
    return { ok: false, error: data?.message || `HTTP ${status}` };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || String(err);
    console.error('[Evolution] findMessages:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Obtém base64 de uma mensagem de mídia (quando o payload do findMessages não traz o arquivo).
 */
async function getBase64FromMediaMessage(instance, messagePayload) {
  const { baseUrl, apiKey, instance: defaultInstance } = getEvolutionConfig();
  const inst = encodeURIComponent(instance || defaultInstance);
  if (!baseUrl || !apiKey || !inst) {
    return { ok: false, error: 'Evolution API não configurada' };
  }
  const url = `${baseUrl.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${inst}`;
  try {
    const { data, status } = await axios.post(
      url,
      { message: messagePayload, convertToMp4: false },
      { headers: buildHeaders(apiKey), timeout: 120000 }
    );
    if (status >= 200 && status < 300) return { ok: true, data };
    return { ok: false, error: data?.message || `HTTP ${status}` };
  } catch (err) {
    const msg = err.response?.data?.message || err.message || String(err);
    console.error('[Evolution] getBase64FromMediaMessage:', msg);
    return { ok: false, error: msg };
  }
}

module.exports = {
  sendText,
  jidToNumber,
  getEvolutionConfig,
  findChats,
  findMessages,
  getBase64FromMediaMessage,
};
