/**
 * Processa webhooks da Evolution API (MESSAGES_UPSERT).
 * Reutiliza a lógica do bot (IA, candidatura, comandos #assumir/#pausa) e envia respostas via Evolution API.
 */
const { cfg } = require('./config');
const { sendText, getEvolutionConfig, getBase64FromMediaMessage } = require('./services/evolutionService');
const { loadWebhookChatState, saveWebhookChatState, clearWebhookChatState, useSupabasePersistence } = require('./services/webhookSessionStore');
const { adicionarMensagemAoHistorico } = require('./chatServiceDiamond');
const { runRecruitmentFunnelTurn, deliverWithDelays } = require('./recruitmentFunnel');
const { saveWhatsappApplication, hasResumeRegisteredForPhone } = require('./services/applicationsService');
const { extrairDadosCurriculo } = require('./services/resumeAnalysisService');

// Estado em memória (persiste em warm invocations no serverless)
const globalState = global.evoluxWebhookState || {
  applicationSessions: new Map(),
  funnelAwaitingClassification: new Set(),
  pausedChats: new Set(),
  processedMessageIds: new Map(),
  processingMessages: new Map(),
  lastMessageTime: new Map(),
};
global.evoluxWebhookState = globalState;
if (!globalState.funnelAwaitingClassification) {
  globalState.funnelAwaitingClassification = new Set();
}

const PROCESSED_TTL_MS = 5 * 60 * 1000;

function formatarTelefone(digits) {
  const d = String(digits).replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 13 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  return d || digits;
}

function getContentTypeFromMessage(message) {
  if (!message) return '';
  if (message.conversation || message.extendedTextMessage) return 'conversation';
  if (message.imageMessage) return 'imageMessage';
  if (message.documentMessage) return 'documentMessage';
  if (message.videoMessage) return 'videoMessage';
  return '';
}

function getTextFromMessage(message, messageBody) {
  if (messageBody && typeof messageBody === 'string') return messageBody.trim();
  const msg = message || {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.documentMessage?.caption ||
    ''
  ).trim();
}

function getMediaBase64(message) {
  const msg = message || {};
  const image = msg.imageMessage || msg.documentMessage;
  if (!image) return null;
  return image.base64 || image.url?.base64 || null;
}

function getMediaInfo(message) {
  const msg = message || {};
  const doc = msg.documentMessage;
  const img = msg.imageMessage;
  if (doc) {
    return {
      fileName: doc.fileName || doc.title || 'curriculo.pdf',
      mimetype: doc.mimetype || 'application/pdf',
    };
  }
  if (img) {
    const mimetype = img.mimetype || 'image/jpeg';
    const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
    return {
      fileName: img.caption && /\.(jpg|jpeg|png|webp)$/i.test(img.caption) ? img.caption : `curriculo.${ext}`,
      mimetype,
    };
  }
  return null;
}

/**
 * Extrai o nome da instância (string) do payload da Evolution API.
 * Suporta: string ou objeto { name, instanceName, instance } (Evolution v2).
 */
function resolveInstanceName(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return (value.name || value.instanceName || value.instance || '').trim();
  return '';
}

/**
 * Normaliza o payload da Evolution API para uma lista de mensagens.
 * Suporta: event MESSAGES_UPSERT ou messages.upsert; data.messages[] e data como mensagem única; instance como objeto.
 */
function parseEvolutionPayload(body) {
  const event = body?.event || body?.type;
  const rawInstance = body?.instance ?? body?.data?.instance ?? getEvolutionConfig().instance;
  const instance = resolveInstanceName(rawInstance) || resolveInstanceName(getEvolutionConfig().instance);
  const data = body?.data || body;

  if (!data || typeof data !== 'object') return { instance, messages: [] };
  const ev = (event || '').toLowerCase().replace(/\s/g, '');
  const hasMessages = Array.isArray(data.messages) || (data.key && (data.message || data.messageBody !== undefined));
  const isMessagesUpsert =
    ev === 'messages.upsert' || ev === 'messages_upsert' || ev === 'messages-upsert' || (ev.includes('messages') && ev.includes('upsert'));
  if (!isMessagesUpsert && !hasMessages) {
    return { instance, messages: [] };
  }

  let list = [];
  if (Array.isArray(data.messages)) {
    list = data.messages;
  } else if (data.key && (data.message || data.messageBody !== undefined)) {
    list = [data];
  }

  const messages = list.map((item) => {
    const key = item.key || {};
    const msg = item.message || {};
    const chatId = key.remoteJid || key.senderPn || '';
    const fromMe = key.fromMe === true;
    const messageId = key.id || key.messageId || '';
    const messageTimestamp = item.messageTimestamp ?? msg.messageTimestamp ?? data.messageTimestamp ?? Math.floor(Date.now() / 1000);
    const contentType = getContentTypeFromMessage(msg);
    const text = getTextFromMessage(msg, item.messageBody);
    const mediaBase64 = getMediaBase64(msg);
    const mediaInfo = getMediaInfo(msg);

    return {
      chatId,
      fromMe,
      messageId,
      messageTimestamp: typeof messageTimestamp === 'number' ? messageTimestamp : parseInt(String(messageTimestamp), 10) || 0,
      contentType,
      text,
      mediaBase64,
      fileName: mediaInfo?.fileName,
      mimetype: mediaInfo?.mimetype,
      /** Envelope bruto (key + message) — usado se o webhook não enviar base64 (webhookBase64) */
      evolutionRawMessage: item,
    };
  });

  return { instance, messages };
}

function wasProcessed(messageId) {
  if (!messageId) return false;
  const ts = globalState.processedMessageIds.get(messageId);
  if (!ts) return false;
  if (Date.now() - ts > PROCESSED_TTL_MS) {
    globalState.processedMessageIds.delete(messageId);
    return false;
  }
  return true;
}

function markProcessed(messageId) {
  if (messageId) globalState.processedMessageIds.set(messageId, Date.now());
  if (globalState.processedMessageIds.size > 500) {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    for (const [k, t] of globalState.processedMessageIds.entries()) {
      if (t < cutoff) globalState.processedMessageIds.delete(k);
    }
  }
}

function stripDataUrlBase64(b64) {
  if (typeof b64 !== 'string') return '';
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 7).trim() : b64.trim();
}

function isConfirmationText(textNorm) {
  const t = (textNorm || '').trim();
  if (!t) return false;
  return t === 'sim' || t === 's' || t === 'nao' || t === 'não' || t === 'n';
}

/**
 * Webhook às vezes não traz documentMessage.base64 (evolution sem webhookBase64).
 * Recupera via Evolution API usando o envelope da mensagem.
 */
async function resolveWebhookMediaBase64(instance, existingBase64, evolutionRawMessage) {
  const direct = stripDataUrlBase64(existingBase64 || '');
  if (direct) return direct;
  if (!evolutionRawMessage || typeof evolutionRawMessage !== 'object') return null;
  const res = await getBase64FromMediaMessage(instance, evolutionRawMessage);
  if (!res.ok || !res.data) {
    console.warn('[Webhook] getBase64FromMediaMessage:', res.error || 'sem dados');
    return null;
  }
  const d = res.data;
  const raw = d.base64 ?? d?.data ?? (typeof d === 'string' ? d : '');
  const b64 = stripDataUrlBase64(typeof raw === 'string' ? raw : '');
  return b64 || null;
}

async function hydrateWebhookStateFromDb(chatId) {
  if (!useSupabasePersistence()) return;
  try {
    const loaded = await loadWebhookChatState(chatId);
    if (loaded.applicationSession) {
      globalState.applicationSessions.set(chatId, loaded.applicationSession);
    } else {
      globalState.applicationSessions.delete(chatId);
    }
    if (loaded.funnelAwaitingClassification) globalState.funnelAwaitingClassification.add(chatId);
    else globalState.funnelAwaitingClassification.delete(chatId);
  } catch (e) {
    console.warn('[Webhook] hydrate estado:', e?.message || e);
  }
}

async function persistWebhookStateToDb(chatId) {
  if (!useSupabasePersistence()) return;
  try {
    await saveWebhookChatState(
      chatId,
      globalState.applicationSessions.get(chatId) || null,
      globalState.funnelAwaitingClassification.has(chatId)
    );
  } catch (_) {}
}

function calcularDelayResposta(textoResposta) {
  const minDelay = cfg.RESPONSE_DELAY_MIN_MS || 2000;
  const maxDelay = cfg.RESPONSE_DELAY_MAX_MS || 5000;
  const delayPerChar = cfg.RESPONSE_DELAY_PER_CHAR_MS || 50;
  const delayCalculado = minDelay + (textoResposta.length * delayPerChar);
  return Math.min(delayCalculado, maxDelay);
}

async function aguardarDelayEntreMensagens(chatId) {
  const minDelay = cfg.MIN_DELAY_BETWEEN_MESSAGES_MS || 3000;
  const lastTime = globalState.lastMessageTime.get(chatId) || 0;
  const now = Date.now();
  const timeSinceLastMessage = now - lastTime;
  if (timeSinceLastMessage < minDelay) {
    const waitTime = minDelay - timeSinceLastMessage;
    await new Promise((r) => setTimeout(r, waitTime));
  }
  globalState.lastMessageTime.set(chatId, Date.now());
}

/**
 * Processa uma mensagem recebida via webhook e envia respostas pela Evolution API.
 */
async function handleOneMessage(instance, payload) {
  const {
    chatId,
    fromMe,
    messageId,
    messageTimestamp,
    contentType,
    text: rawText,
    mediaBase64,
    fileName,
    mimetype,
    evolutionRawMessage,
  } = payload;

  const enviarMensagemSegura = async (toChatId, texto, salvarNoHistorico = true) => {
    const result = await sendText(instance, toChatId, texto);
    if (result.success && salvarNoHistorico) {
      adicionarMensagemAoHistorico(toChatId, 'assistant', texto);
    }
    if (!result.success) throw new Error(result.error || 'Falha ao enviar');
  };

  if (fromMe) return;
  if (wasProcessed(messageId)) return;
  if (!chatId) return;

  const isGroup = chatId.endsWith('@g.us');
  if (isGroup) return;

  const maxAgeMs = cfg.MESSAGE_MAX_AGE_MS || 30 * 60 * 1000;
  const ts = messageTimestamp ? Number(messageTimestamp) * 1000 : Date.now();
  if (Date.now() - ts > maxAgeMs) return;

  const hasBody = (rawText || '').length > 0;
  const isImage = contentType === 'imageMessage';
  const isDocument = contentType === 'documentMessage';
  const hasMedia = isImage || isDocument;
  if (!hasBody && !hasMedia) return;

  const textNorm = (rawText || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const comandoNorm = textNorm.replace(/#\s+/g, '#');

  if (comandoNorm === '#assumir') {
    globalState.pausedChats.add(chatId);
    markProcessed(messageId);
    const resposta = '✅ Bot pausado. A conversa foi assumida manualmente.\n\nPara reativar o bot, envie: #pausa';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(chatId, resposta);
    return;
  }
  if (comandoNorm === '#pausa') {
    globalState.pausedChats.delete(chatId);
    markProcessed(messageId);
    const resposta = '✅ Bot reativado! Voltando a responder automaticamente.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(chatId, resposta);
    return;
  }
  if (globalState.pausedChats.has(chatId)) {
    markProcessed(messageId);
    return;
  }

  if (globalState.processingMessages.has(chatId)) return;
  globalState.processingMessages.set(chatId, true);
  markProcessed(messageId);
  await aguardarDelayEntreMensagens(chatId);

  try {
    await hydrateWebhookStateFromDb(chatId);

    let hasSession = globalState.applicationSessions.has(chatId);

    if (hasSession) {
      const handled = await handleApplicationStepEvolution(
        instance,
        chatId,
        {
          rawText,
          textNorm,
          contentType,
          mediaBase64,
          fileName,
          mimetype,
          isImage,
          isDocument,
          evolutionRawMessage,
        },
        enviarMensagemSegura,
        calcularDelayResposta
      );
      if (handled) return;
    }

    // Fallback resiliente para ambiente stateless (ex.: serverless sem sessão persistida):
    // se chegar currículo (imagem/PDF) sem sessão ativa, inicia a candidatura automaticamente
    // e processa o arquivo, evitando cair novamente na pergunta CANDIDATO/EMPRESA.
    if (!hasSession && hasMedia) {
      console.warn('[Webhook] Sessão de candidatura ausente ao receber mídia; iniciando fluxo automaticamente.');
      globalState.applicationSessions.set(chatId, { step: 'resume', data: {}, resume: null });
      hasSession = true;
      const handled = await handleApplicationStepEvolution(
        instance,
        chatId,
        {
          rawText,
          textNorm,
          contentType,
          mediaBase64,
          fileName,
          mimetype,
          isImage,
          isDocument,
          evolutionRawMessage,
        },
        enviarMensagemSegura,
        calcularDelayResposta
      );
      if (handled) {
        if (hasBody) adicionarMensagemAoHistorico(chatId, 'user', rawText);
        else adicionarMensagemAoHistorico(chatId, 'user', '(mídia)');
        await persistWebhookStateToDb(chatId);
        return;
      }
      if (!globalState.applicationSessions.get(chatId)?.resume) {
        globalState.applicationSessions.delete(chatId);
        hasSession = false;
      }
    }

    if (!hasSession && hasBody && isConfirmationText(textNorm)) {
      const isPositiveConfirmation = textNorm === 'sim' || textNorm === 's';
      if (isPositiveConfirmation) {
        try {
          const alreadyRegistered = await hasResumeRegisteredForPhone(chatId);
          if (alreadyRegistered) {
            const okMsg =
              '🎉 *Candidatura registrada com sucesso!*\n\nSeus dados já foram salvos no banco e nossa equipe entrará em contato em breve.\n\nObrigada por se candidatar na EvoluxRH! 😊';
            await new Promise((r) => setTimeout(r, calcularDelayResposta(okMsg)));
            await enviarMensagemSegura(chatId, okMsg);
            await endApplicationSession(chatId);
            if (hasBody) adicionarMensagemAoHistorico(chatId, 'user', rawText);
            return;
          }
        } catch (e) {
          console.warn('[Webhook] Falha ao verificar candidatura existente por telefone:', e?.message || e);
        }
      }

      const resposta =
        'Não consegui recuperar sua sessão de candidatura para confirmar os dados.\n\nPor favor, envie novamente o seu *currículo* (PDF ou foto da primeira página) para eu analisar e finalizar seu cadastro no banco.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      globalState.applicationSessions.set(chatId, { step: 'resume', data: {}, resume: null });
      await persistWebhookStateToDb(chatId);
      if (hasBody) adicionarMensagemAoHistorico(chatId, 'user', rawText);
      return;
    }

    const awaiting = globalState.funnelAwaitingClassification.has(chatId);
    const sendMessages = async (msgs) => {
      await deliverWithDelays(msgs, calcularDelayResposta, async (m) => {
        await enviarMensagemSegura(chatId, m);
      });
    };

    const funnelResult = await runRecruitmentFunnelTurn({
      textNorm,
      hasBody,
      hasMedia,
      awaitingClassification: awaiting,
      sendMessages,
    });

    if (funnelResult.awaitingClassification) globalState.funnelAwaitingClassification.add(chatId);
    else globalState.funnelAwaitingClassification.delete(chatId);

    if (funnelResult.startApplication) {
      globalState.applicationSessions.set(chatId, { step: 'resume', data: {}, resume: null });
    }

    if (funnelResult.handled) {
      if (hasBody) adicionarMensagemAoHistorico(chatId, 'user', rawText);
      else if (hasMedia) adicionarMensagemAoHistorico(chatId, 'user', '(mídia)');
      await persistWebhookStateToDb(chatId);
      return;
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err?.message);
    try {
      await sendText(instance, chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    } catch (_) {}
  } finally {
    globalState.processingMessages.delete(chatId);
    await persistWebhookStateToDb(chatId);
  }
}

async function endApplicationSession(chatId) {
  globalState.applicationSessions.delete(chatId);
  globalState.funnelAwaitingClassification.delete(chatId);
  await clearWebhookChatState(chatId);
}

function buildApplicationPayload(chatId, session) {
  const defaultExt = (session.resume?.mimetype || '').startsWith('image/')
    ? session.resume.mimetype === 'image/png'
      ? 'png'
      : session.resume.mimetype === 'image/webp'
        ? 'webp'
        : 'jpg'
    : 'pdf';
  const defaultName = (session.resume?.mimetype || '').startsWith('image/') ? `curriculo.${defaultExt}` : 'curriculo.pdf';

  return {
    chatId,
    fullName: session.data.fullName || 'Não informado',
    email: session.data.email || null,
    whatsappNumber: session.data.phone || chatId,
    city: session.data.city || null,
    jobInterest: session.data.jobInterest || 'Não especificado',
    resumeBase64: session.resume?.base64 || '',
    resumeFilename: session.resume?.filename || defaultName,
    resumeMimetype: session.resume?.mimetype || (defaultExt === 'pdf' ? 'application/pdf' : `image/${defaultExt}`),
  };
}

async function handleApplicationStepEvolution(
  instance,
  chatId,
  { rawText, textNorm, contentType, mediaBase64, fileName, mimetype, isImage, isDocument, evolutionRawMessage },
  enviarMensagemSegura,
  calcularDelayResposta
) {
  const session = globalState.applicationSessions.get(chatId);
  if (!session) return false;
  const text = rawText || '';

  if (session.step === 'resume') {
    if (isDocument || isImage) {
      const effectiveBase64 = await resolveWebhookMediaBase64(instance, mediaBase64, evolutionRawMessage);
      if (!effectiveBase64) {
        await enviarMensagemSegura(
          chatId,
          'Recebi o arquivo, mas não consegui ler o conteúdo (mídia sem base64). Na Evolution API, ative **webhookBase64: true** no webhook ou envie o PDF novamente.'
        );
        return true;
      }

      const buf = Buffer.from(effectiveBase64, 'base64');
      let fname = fileName || 'curriculo.pdf';
      let mime = mimetype || 'application/pdf';
      if (isImage) {
        if (!mime || mime === 'application/pdf') mime = 'image/jpeg';
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        if (!/\.(jpg|jpeg|png|webp)$/i.test(fname)) fname = `curriculo.${ext}`;
      }
      session.resume = { buffer: buf, filename: fname, mimetype: mime, base64: effectiveBase64 };

      await enviarMensagemSegura(chatId, '📄 Recebi seu currículo! Estou analisando com IA, aguarde um momento...');

      let extracted = null;
      try {
        extracted = await extrairDadosCurriculo(buf, mime);
      } catch (e) {
        console.error('[Webhook] Erro ao analisar currículo com IA:', e?.message || e);
      }

      if (extracted && (extracted.fullName || extracted.email || extracted.phone)) {
        session.data.fullName = extracted.fullName || session.data.fullName || '';
        session.data.email = extracted.email || session.data.email || '';
        session.data.phone = extracted.phone || session.data.phone || '';
        session.data.city = extracted.city || session.data.city || '';
        session.data.jobInterest = extracted.jobInterest || session.data.jobInterest || '';
        try {
          if (!session.savedToDb) {
            await saveWhatsappApplication(buildApplicationPayload(chatId, session));
            session.savedToDb = true;
          }
        } catch (error) {
          console.error('[Webhook] Erro ao salvar candidatura no recebimento do currículo:', error);
        }
        const linhas = [
          '📄 *Currículo recebido!* Analisei com IA e extraí estes dados:',
          '',
          `• Nome: ${session.data.fullName || '(não encontrado)'}`,
          `• E-mail: ${session.data.email || '(não encontrado)'}`,
          `• Telefone: ${session.data.phone ? formatarTelefone(session.data.phone) : '(não encontrado)'}`,
          `• Cidade: ${session.data.city || '(não encontrado)'}`,
          `• Área de interesse: ${session.data.jobInterest || '(não encontrado)'}`,
          '',
          'Está tudo correto? Responda *SIM* para confirmar e finalizar a candidatura, ou *NÃO* para preencher manualmente.',
        ];
        const resposta = linhas.join('\n');
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(chatId, resposta);
        session.step = 'confirm_extracted';
        return true;
      }

      const resposta =
        'Currículo recebido! Não consegui ler os dados automaticamente.\n\n📷 *Dica:* Envie uma *foto* (imagem) da primeira página do currículo — a IA consegue analisar fotos. Ou informe seu *nome completo* para continuarmos manualmente.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'name';
      return true;
    }
    return true;
  }

  if (session.step === 'confirm_extracted') {
    if (textNorm.includes('sim') || textNorm.includes('s ') || textNorm === 's') {
      try {
        if (!session.savedToDb) {
          await saveWhatsappApplication(buildApplicationPayload(chatId, session));
          session.savedToDb = true;
        }
        const resposta =
          '🎉 *Candidatura registrada com sucesso!*\n\nSeus dados foram salvos e nossa equipe entrará em contato em breve.\n\nObrigada por se candidatar na EvoluxRH! 😊';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(chatId, resposta);
        await endApplicationSession(chatId);
        return true;
      } catch (error) {
        console.error('[Webhook] Erro ao salvar candidatura:', error);
        await enviarMensagemSegura(chatId, 'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.');
        return true;
      }
    }
    if (textNorm.includes('não') || textNorm.includes('nao')) {
      const resposta = 'Sem problemas! Por favor, informe seu *nome completo* para preenchermos manualmente.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'name';
      session.data = {};
      return true;
    }
    return true;
  }

  if (session.step === 'name') {
    if (text.trim().length >= 2) {
      session.data.fullName = text.trim();
      const resposta = 'Ótimo! Agora preciso do seu *e-mail*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'email';
      return true;
    }
    await enviarMensagemSegura(chatId, 'Por favor, informe seu nome completo.');
    return true;
  }

  if (session.step === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(text)) {
      session.data.email = text.trim();
      const resposta = 'Perfeito! Agora preciso do seu *número de telefone* (com DDD). Ex: 98999998888';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'phone';
      return true;
    }
    await enviarMensagemSegura(chatId, 'Por favor, informe um e-mail válido.');
    return true;
  }

  if (session.step === 'phone') {
    const digits = (text || '').replace(/\D/g, '');
    if (digits.length >= 10) {
      session.data.phone = digits;
      const resposta = 'Ótimo! Agora preciso da sua *cidade*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'city';
      return true;
    }
    await enviarMensagemSegura(chatId, 'Por favor, informe um número válido com DDD (mínimo 10 dígitos). Ex: 98999998888');
    return true;
  }

  if (session.step === 'city') {
    if (text.trim().length >= 2) {
      session.data.city = text.trim();
      const resposta = 'Excelente! Por último, qual *área de interesse* ou vaga você tem interesse?';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'job';
      return true;
    }
    await enviarMensagemSegura(chatId, 'Por favor, informe sua cidade.');
    return true;
  }

  if (session.step === 'job') {
    session.data.jobInterest = (text || '').trim() || 'Não especificado';
    const resumo =
      `✅ *Confirme seus dados:*\n\n` +
      `- Nome: ${session.data.fullName}\n` +
      `- E-mail: ${session.data.email}\n` +
      `- Telefone: ${session.data.phone || '(não informado)'}\n` +
      `- Cidade: ${session.data.city}\n` +
      `- Área de interesse: ${session.data.jobInterest}\n\n` +
      `Está tudo correto? Responda *SIM* para confirmar ou *NÃO* para corrigir.`;
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resumo)));
    await enviarMensagemSegura(chatId, resumo);
    session.step = 'confirm';
    return true;
  }

  if (session.step === 'confirm') {
    if (textNorm.includes('sim') || textNorm.includes('s ') || textNorm === 's') {
      try {
        if (!session.savedToDb) {
          await saveWhatsappApplication(buildApplicationPayload(chatId, session));
          session.savedToDb = true;
        }
        const resposta =
          '🎉 *Candidatura registrada com sucesso!*\n\nSeus dados foram salvos e nossa equipe entrará em contato em breve.\n\nObrigada por se candidatar na EvoluxRH! 😊';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(chatId, resposta);
        await endApplicationSession(chatId);
        return true;
      } catch (error) {
        console.error('[Webhook] Erro ao salvar candidatura:', error);
        await enviarMensagemSegura(chatId, 'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.');
        return true;
      }
    }
    if (textNorm.includes('não') || textNorm.includes('nao')) {
      const resposta = 'Sem problemas! Qual dado você gostaria de corrigir? (nome, email, telefone, cidade ou vaga)';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'correcting';
      return true;
    }
    return true;
  }

  return false;
}

/**
 * Processa o body do webhook (Evolution API) e responde às mensagens.
 * @param {object} body - Body parseado (JSON) do POST do webhook
 * @returns {Promise<{ processed: number, instance?: string }>}
 */
async function processWebhookBody(body) {
  const { instance, messages } = parseEvolutionPayload(body);
  if (!instance) {
    console.warn('[Webhook] Payload sem instance, usando config');
  }
  const inst = instance || getEvolutionConfig().instance;
  if (messages.length > 0) {
    console.log('[Webhook] Evolution API: event processado, instance:', inst, 'mensagens:', messages.length);
  }
  let processed = 0;
  for (const msg of messages) {
    if (!msg.chatId) continue;
    await handleOneMessage(inst, msg);
    processed++;
  }
  return { processed, instance: inst };
}

module.exports = { processWebhookBody, parseEvolutionPayload };
