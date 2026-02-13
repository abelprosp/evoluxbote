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

module.exports = {
  sendText,
  jidToNumber,
  getEvolutionConfig,
};
