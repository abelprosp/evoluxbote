/**
 * Processa webhooks da Evolution API (MESSAGES_UPSERT).
 * Reutiliza a lógica do bot (IA, candidatura, comandos #assumir/#pausa) e envia respostas via Evolution API.
 */
const { cfg } = require('./config');
const { sendText, getEvolutionConfig } = require('./services/evolutionService');
const { obterContexto, gerarResposta, analisarImagem, conversas, adicionarMensagemAoHistorico } = require('./chatServiceDiamond');
const { saveWhatsappApplication } = require('./services/applicationsService');

// Estado em memória (persiste em warm invocations no serverless)
const globalState = global.evoluxWebhookState || {
  applicationSessions: new Map(),
  pausedChats: new Set(),
  processedMessageIds: new Map(),
  processingMessages: new Map(),
  lastMessageTime: new Map(),
};
global.evoluxWebhookState = globalState;

const PROCESSED_TTL_MS = 5 * 60 * 1000;

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
 * Normaliza o payload da Evolution API para uma lista de mensagens.
 * Suporta: data.messages[] e data como mensagem única; key.remoteJid, message, messageTimestamp.
 */
function parseEvolutionPayload(body) {
  const event = body?.event || body?.type;
  const instance = body?.instance || body?.data?.instance || getEvolutionConfig().instance;
  const data = body?.data || body;

  if (!data || typeof data !== 'object') return { instance, messages: [] };
  const ev = (event || '').toLowerCase();
  const hasMessages = Array.isArray(data.messages) || (data.key && (data.message || data.messageBody !== undefined));
  if (ev !== 'messages.upsert' && !hasMessages) {
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
  const comandoNorm = textNorm.replace(/#\s+/, '#');

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
    const hasSession = globalState.applicationSessions.has(chatId);

    if (hasSession) {
      const handled = await handleApplicationStepEvolution(
        instance,
        chatId,
        { rawText, textNorm, contentType, mediaBase64, fileName, mimetype, isImage, isDocument },
        enviarMensagemSegura,
        calcularDelayResposta
      );
      if (handled) return;
    }

    const isApplicationTrigger = [
      'quero me candidatar',
      'gostaria de me candidatar',
      'fazer minha candidatura',
      'enviar meu curriculo',
      'enviar currículo',
      'quero trabalhar',
      'quero uma vaga',
    ].some((k) => textNorm.includes(k));
    if (isApplicationTrigger && !hasSession) {
      globalState.applicationSessions.set(chatId, { step: 'resume', data: {}, resume: null });
      const resposta = 'Ótimo! Vamos começar sua candidatura! 📝\n\nPor favor, envie seu *currículo* (PDF, DOCX ou imagem).';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      return;
    }

    if ((isDocument || isImage) && !hasSession) {
      const resposta =
        'Olá! Sou a *Iza da EvoluxRH* 😊\n\nVi que você enviou um arquivo ou imagem! 📄🖼️\n\nPara registrar sua candidatura, me diga "quero me candidatar" e eu te guio passo a passo!';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      return;
    }

    let descricaoImagem = null;
    if (isImage && mediaBase64) {
      try {
        const buffer = Buffer.from(mediaBase64, 'base64');
        descricaoImagem = await analisarImagem(buffer, rawText);
      } catch (e) {
        console.error('[Webhook] Erro ao analisar imagem:', e?.message);
      }
    }

    const contexto = obterContexto(chatId, 'Candidato', chatId);
    if (!conversas.has(chatId)) {
      const resposta =
        'Olá! Sou a Iza da EvoluxRH! 😊\n\nComo posso ajudar hoje? Há vagas disponíveis no site evoluxrh.com.br. Se quiser se candidatar, posso te orientar.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
    }

    adicionarMensagemAoHistorico(chatId, 'user', rawText || '(mídia)');
    try {
      const resposta = await gerarResposta(contexto, rawText || '', descricaoImagem);
      if (resposta && resposta.trim()) {
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(chatId, resposta, true);
      }
    } catch (error) {
      console.error('[Webhook] Erro ao gerar resposta:', error?.message);
      await enviarMensagemSegura(chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    }
  } catch (err) {
    console.error('[Webhook] Erro:', err?.message);
    try {
      await sendText(instance, chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    } catch (_) {}
  } finally {
    globalState.processingMessages.delete(chatId);
  }
}

async function handleApplicationStepEvolution(
  instance,
  chatId,
  { rawText, textNorm, contentType, mediaBase64, fileName, mimetype, isImage, isDocument },
  enviarMensagemSegura,
  calcularDelayResposta
) {
  const session = globalState.applicationSessions.get(chatId);
  if (!session) return false;
  const text = rawText || '';

  if (session.step === 'resume') {
    if ((isDocument || isImage) && mediaBase64) {
      const buf = Buffer.from(mediaBase64, 'base64');
      let fname = fileName || 'curriculo.pdf';
      let mime = mimetype || 'application/pdf';
      if (isImage) {
        if (!mime || mime === 'application/pdf') mime = 'image/jpeg';
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        if (!/\.(jpg|jpeg|png|webp)$/i.test(fname)) fname = `curriculo.${ext}`;
      }
      session.resume = { buffer: buf, filename: fname, mimetype: mime, base64: mediaBase64 };
      const resposta = 'Currículo recebido! Agora preciso do seu *nome completo*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(chatId, resposta);
      session.step = 'name';
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
        const defaultExt = (session.resume?.mimetype || '').startsWith('image/')
          ? session.resume.mimetype === 'image/png'
            ? 'png'
            : session.resume.mimetype === 'image/webp'
              ? 'webp'
              : 'jpg'
          : 'pdf';
        const defaultName = (session.resume?.mimetype || '').startsWith('image/') ? `curriculo.${defaultExt}` : 'curriculo.pdf';
        await saveWhatsappApplication({
          chatId,
          fullName: session.data.fullName,
          email: session.data.email,
          whatsappNumber: session.data.phone || chatId,
          city: session.data.city,
          jobInterest: session.data.jobInterest,
          resumeBase64: session.resume?.base64 || '',
          resumeFilename: session.resume?.filename || defaultName,
          resumeMimetype: session.resume?.mimetype || (defaultExt === 'pdf' ? 'application/pdf' : `image/${defaultExt}`),
        });
        const resposta =
          '🎉 *Candidatura registrada com sucesso!*\n\nSeus dados foram salvos e nossa equipe entrará em contato em breve.\n\nObrigada por se candidatar na EvoluxRH! 😊';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(chatId, resposta);
        globalState.applicationSessions.delete(chatId);
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
  let processed = 0;
  for (const msg of messages) {
    if (!msg.chatId) continue;
    await handleOneMessage(inst, msg);
    processed++;
  }
  return { processed, instance: inst };
}

module.exports = { processWebhookBody, parseEvolutionPayload };
