const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.makeWASocket || baileys.default || baileys;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const DisconnectReason = baileys.DisconnectReason;
const downloadMediaMessage = baileys.downloadMediaMessage;
const getContentType = baileys.getContentType;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const fetchLatestWaWebVersion = baileys.fetchLatestWaWebVersion;
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { obterContexto, gerarResposta, analisarImagem, conversas, adicionarMensagemAoHistorico } = require('./chatServiceDiamond');
const { saveWhatsappApplication } = require('./services/applicationsService');
const { extrairDadosCurriculo } = require('./services/resumeAnalysisService');
const { cfg } = require('./config');
const { matchesCompanyHiringIntent, getLuizaRedirectMessage } = require('./companyHiringFlow');

function formatarTelefone(digits) {
  const d = String(digits).replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 13 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  return d || digits;
}

const AUTH_FOLDER = 'auth_info_baileys';

const lastMessageTime = new Map();
const processingMessages = new Map();

function calcularDelayResposta(textoResposta) {
  const minDelay = cfg.RESPONSE_DELAY_MIN_MS || 2000;
  const maxDelay = cfg.RESPONSE_DELAY_MAX_MS || 5000;
  const delayPerChar = cfg.RESPONSE_DELAY_PER_CHAR_MS || 50;
  const delayCalculado = minDelay + (textoResposta.length * delayPerChar);
  return Math.min(delayCalculado, maxDelay);
}

async function aguardarDelayEntreMensagens(chatId) {
  const minDelay = cfg.MIN_DELAY_BETWEEN_MESSAGES_MS || 3000;
  const lastTime = lastMessageTime.get(chatId) || 0;
  const now = Date.now();
  const timeSinceLastMessage = now - lastTime;
  if (timeSinceLastMessage < minDelay) {
    const waitTime = minDelay - timeSinceLastMessage;
    console.log(`[WhatsApp] ⏳ Aguardando ${waitTime}ms antes de processar mensagem de ${chatId}`);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
  lastMessageTime.set(chatId, Date.now());
}

async function enviarMensagemSegura(sock, chatId, texto, salvarNoHistorico = true) {
  try {
    console.log(`[WhatsApp] 📤 Enviando mensagem para ${chatId} (${texto.length} chars)`);
    await sock.sendMessage(chatId, { text: texto });
    if (salvarNoHistorico) {
      adicionarMensagemAoHistorico(chatId, 'assistant', texto);
    }
    console.log(`[WhatsApp] ✅ Mensagem enviada para ${chatId}`);
    return { _enviado: true };
  } catch (error) {
    console.error(`[WhatsApp] ❌ Erro ao enviar mensagem para ${chatId}:`, error?.message);
    throw error;
  }
}

/**
 * Cria e inicializa o cliente WhatsApp usando Baileys (WebSocket, sem browser).
 * Retorna uma Promise que resolve com o sock quando a conexão estiver aberta.
 */
function createWhatsAppClient() {
  console.log('[WhatsApp] Iniciando Baileys (conexão direta, sem browser)...');

  const applicationSessions = new Map();
  const processedMessageIds = new Map();
  const PROCESSED_TTL_MS = 5 * 60 * 1000;
  const pausedChats = new Set();

  function getMessageId(msg) {
    if (!msg?.key?.id) return null;
    return msg.key.id;
  }

  function wasProcessed(msg) {
    const id = getMessageId(msg);
    if (!id) return false;
    const ts = processedMessageIds.get(id);
    if (!ts) return false;
    if (Date.now() - ts > PROCESSED_TTL_MS) {
      processedMessageIds.delete(id);
      return false;
    }
    return true;
  }

  function markProcessed(msg) {
    const id = getMessageId(msg);
    if (id) processedMessageIds.set(id, Date.now());
    if (processedMessageIds.size > 500) {
      const cutoff = Date.now() - PROCESSED_TTL_MS;
      for (const [k, t] of processedMessageIds.entries()) {
        if (t < cutoff) processedMessageIds.delete(k);
      }
    }
  }

  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    let version;
    try {
      const versionInfo = await fetchLatestWaWebVersion();
      version = versionInfo?.version;
      if (version) console.log('[Baileys] Usando versão WhatsApp Web:', version.join('.'));
    } catch (e) {
      console.warn('[Baileys] fetchLatestWaWebVersion falhou, tentando fetchLatestBaileysVersion:', e?.message);
      try {
        const fallback = await fetchLatestBaileysVersion();
        version = fallback?.version;
        if (version) console.log('[Baileys] Usando versão Baileys:', version.join('.'));
      } catch (e2) {
        console.warn('[Baileys] Usando versão padrão do pacote:', e2?.message);
      }
    }

    const socketOptions = {
      auth: state,
      version,
      getMessage: async () => undefined,
      connectTimeoutMs: 60000,
    };
    if (cfg.BAILEYS_PROXY && cfg.BAILEYS_PROXY.trim()) {
      socketOptions.agent = new HttpsProxyAgent(cfg.BAILEYS_PROXY.trim());
      const proxyDisplay = cfg.BAILEYS_PROXY.replace(/:[^:@]+@/, ':****@');
      console.log('[Baileys] Usando proxy:', proxyDisplay);
    }
    const sock = makeWASocket(socketOptions);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n📱 Escaneie o QR Code abaixo com o WhatsApp:\n');
        console.log('   WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho\n');
        try {
          qrcodeTerminal.generate(qr, { small: true });
          const qrPath = path.join(process.cwd(), 'qrcode.png');
          await QRCode.toFile(qrPath, qr, { width: 400, margin: 2 });
          console.log('[WhatsApp] QR Code salvo em qrcode.png\n');
        } catch (e) {
          console.warn('[WhatsApp] Não foi possível salvar qrcode.png:', e?.message);
        }
      }

      if (connection === 'open') {
        console.log('\n✅ Cliente WhatsApp (Baileys) conectado e pronto!');
        console.log('📲 Envie uma mensagem de OUTRO número para testar.\n');
        if (resolveReady) resolveReady(sock);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired; // 515 = após escanear QR
        console.log('[Baileys] Conexão fechada. statusCode:', statusCode, 'reconectar:', shouldReconnect);
        if (statusCode === DisconnectReason.loggedOut) {
          const authPath = path.join(process.cwd(), AUTH_FOLDER);
          if (fs.existsSync(authPath)) {
            try {
              fs.rmSync(authPath, { recursive: true });
              console.log('[Baileys] Pasta', AUTH_FOLDER, 'apagada automaticamente.');
            } catch (e) {
              console.warn('[Baileys] Não foi possível apagar a pasta:', e?.message);
            }
          }
          console.log('[Baileys] Reinicie o bot (npm start ou pm2 restart) para ver o QR e escanear de novo.');
          return;
        }
        if (isRestartRequired) {
          console.log('');
          console.log('📱 QR escaneado! Salvando credenciais e reconectando (aguarde 2–3 segundos)...');
          console.log('   Em seguida deve aparecer: "Cliente WhatsApp (Baileys) conectado e pronto!"');
          console.log('');
        }
        if (statusCode === 405) {
          console.log('');
          console.log('[Baileys] Erro 405 (Connection Failure): o WhatsApp pode estar rejeitando a conexão.');
          console.log('   Dicas: 1) Confira sua internet  2) Tente outra rede (ex.: celular como hotspot)');
          console.log('   3) Apague a pasta', AUTH_FOLDER, 'e inicie o bot de novo para gerar novo QR.');
          console.log('');
        }
        if (shouldReconnect) {
          const delayMs = isRestartRequired ? 2000 : 5000;
          console.log('[Baileys] Reconectando em', delayMs / 1000, 's...');
          setTimeout(() => connectToWhatsApp(), delayMs);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          const chatId = msg.key.remoteJid;
          if (!chatId) continue;
          const fromMe = msg.key.fromMe || false;
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          const contentType = (getContentType(msg.message) || getContentType(msg) || '').toString();

          await handleIncomingMessage(sock, {
            chatId,
            fromMe,
            text: (text || '').trim(),
            contentType,
            msg,
            applicationSessions,
            processedMessageIds,
            pausedChats,
            wasProcessed,
            markProcessed,
            aguardarDelayEntreMensagens,
            calcularDelayResposta,
            enviarMensagemSegura,
            processingMessages,
          });
        } catch (err) {
          console.error('[WhatsApp] Erro ao processar uma mensagem:', err?.message || err);
        }
      }
    });

    return sock;
  }

  connectToWhatsApp().catch((err) => {
    console.error('[WhatsApp] Erro ao conectar Baileys:', err?.message || err);
    if (rejectReady) rejectReady(err);
  });

  return readyPromise;
}

async function handleIncomingMessage(
  sock,
  {
    chatId,
    fromMe,
    text: rawText,
    contentType,
    msg,
    applicationSessions,
    pausedChats,
    wasProcessed,
    markProcessed,
    aguardarDelayEntreMensagens,
    calcularDelayResposta,
    enviarMensagemSegura,
    processingMessages,
  }
) {
  console.log(`[WhatsApp] 📩 Evento de mensagem recebido de ${chatId}`);

  try {
    if (fromMe) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem enviada por mim`);
      return;
    }
    if (wasProcessed(msg)) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem já processada`);
      return;
    }

    const isGroup = chatId.endsWith('@g.us');
    if (isGroup) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem de grupo`);
      return;
    }

    const maxAgeMs = cfg.MESSAGE_MAX_AGE_MS || 30 * 60 * 1000;
    const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();
    if (Date.now() - ts > maxAgeMs) {
      console.log(`[WhatsApp] ⏭️ Ignorado: mensagem antiga`);
      return;
    }

    const hasBody = rawText.length > 0;
    const isImage = contentType === 'imageMessage';
    const isDocument = contentType === 'documentMessage';
    const hasMedia = isImage || isDocument;
    if (!hasBody && !hasMedia) {
      const semConteudo = !msg.message || (typeof msg.message !== 'object');
      if (semConteudo) {
        console.log(`[WhatsApp] ⏭️ Ignorado: mensagem sem conteúdo (se aparecer "Bad MAC" no log, apague a pasta auth_info_baileys e escaneie o QR de novo)`);
      } else {
        console.log(`[WhatsApp] ⏭️ Ignorado: mensagem sem texto e sem mídia`);
      }
      return;
    }

    const textNorm = (rawText || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    // Normaliza comando: "# assumir" ou "#  assumir" vira "#assumir"
    const comandoNorm = textNorm.replace(/#\s+/, '#');
    console.log(`[WhatsApp] 📨 Mensagem de ${chatId}: "${(rawText || '').substring(0, 80)}"`);

    if (comandoNorm === '#assumir') {
      pausedChats.add(chatId);
      markProcessed(msg);
      console.log(`[WhatsApp] ⏸️ Bot pausado para ${chatId} (#assumir)`);
      const resposta = '✅ Bot pausado. A conversa foi assumida manualmente.\n\nPara reativar o bot, envie: #pausa';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      return;
    }
    if (comandoNorm === '#pausa') {
      pausedChats.delete(chatId);
      markProcessed(msg);
      console.log(`[WhatsApp] ▶️ Bot reativado para ${chatId} (#pausa)`);
      const resposta = '✅ Bot reativado! Voltando a responder automaticamente.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      return;
    }
    if (pausedChats.has(chatId)) {
      markProcessed(msg);
      return;
    }

    if (processingMessages.has(chatId)) {
      console.log(`[WhatsApp] ⏳ Mensagem aguardando (já há uma sendo processada)`);
      return;
    }
    processingMessages.set(chatId, true);
    markProcessed(msg);
    await aguardarDelayEntreMensagens(chatId);

    const hasSession = applicationSessions.has(chatId);

    if (hasSession) {
      const handled = await handleApplicationStepBaileys(
        sock,
        applicationSessions,
        chatId,
        msg,
        rawText,
        textNorm,
        contentType,
        enviarMensagemSegura,
        calcularDelayResposta,
        downloadMediaMessage
      );
      if (handled) {
        processingMessages.delete(chatId);
        return;
      }
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
      await startApplicationFlow(sock, applicationSessions, chatId, enviarMensagemSegura, calcularDelayResposta);
      processingMessages.delete(chatId);
      return;
    }

    if (hasBody && matchesCompanyHiringIntent(textNorm)) {
      adicionarMensagemAoHistorico(chatId, 'user', rawText);
      const resposta = getLuizaRedirectMessage();
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      processingMessages.delete(chatId);
      return;
    }

    const isResumeMedia = isDocument || isImage;
    if (isResumeMedia && !hasSession) {
      const resposta =
        'Olá! Sou a *Iza da EvoluxRH* 😊\n\nVi que você enviou um arquivo ou imagem! 📄🖼️\n\nPara registrar sua candidatura, me diga "quero me candidatar" e eu te guio passo a passo!';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      processingMessages.delete(chatId);
      return;
    }

    let descricaoImagem = null;
    if (isImage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, sock.updateMediaMessage ? { reuploadRequest: sock.updateMediaMessage } : {});
        if (buffer) descricaoImagem = await analisarImagem(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), rawText);
      } catch (e) {
        console.error('[WhatsApp] Erro ao processar mídia:', e?.message);
      }
    }

    const nomeContato = 'Candidato';
    const primeiraConversa = !conversas.has(chatId);
    const contexto = obterContexto(chatId, nomeContato, chatId);

    if (primeiraConversa) {
      console.log(`[WhatsApp] 👋 Primeira mensagem de ${chatId}, enviando saudação...`);
      const resposta =
        'Olá! Sou a Iza da EvoluxRH! 😊\n\nComo posso ajudar hoje? Há vagas disponíveis no site evoluxrh.com.br. Se quiser se candidatar, posso te orientar.\n\nSe você é *empresa* e quer *contratar* ou fechar *parceria comercial*, me diga — eu te encaminho para a Luiza no WhatsApp dela.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
    }

    adicionarMensagemAoHistorico(chatId, 'user', rawText || '(mídia)');
    console.log(`[WhatsApp] 🤖 Gerando resposta com IA para ${chatId}...`);
    try {
      const resposta = await gerarResposta(contexto, rawText || '', descricaoImagem);
      if (resposta && resposta.trim()) {
        const delay = calcularDelayResposta(resposta);
        await new Promise((r) => setTimeout(r, delay));
        await enviarMensagemSegura(sock, chatId, resposta, true);
      }
    } catch (error) {
      console.error(`[WhatsApp] ❌ Erro ao gerar/enviar resposta:`, error?.message);
      await enviarMensagemSegura(sock, chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    }
  } catch (error) {
    console.error('[WhatsApp] ❌ Erro ao processar mensagem:', error?.message);
    try {
      await enviarMensagemSegura(sock, chatId, 'Desculpe, houve um erro ao processar sua mensagem. Tente novamente, por favor.');
    } catch (sendError) {
      console.error('[WhatsApp] ❌ Erro ao enviar mensagem de erro:', sendError?.message);
    }
  } finally {
    processingMessages.delete(chatId);
  }
}

async function startApplicationFlow(sock, applicationSessions, chatId, enviarMensagemSegura, calcularDelayResposta) {
  applicationSessions.set(chatId, { step: 'resume', data: {}, resume: null });
  const resposta = 'Ótimo! Vamos começar sua candidatura! 📝\n\nPor favor, envie seu *currículo* (PDF, DOCX ou imagem).';
  await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
  await enviarMensagemSegura(sock, chatId, resposta);
}

async function handleApplicationStepBaileys(
  sock,
  applicationSessions,
  chatId,
  msg,
  text,
  textNorm,
  contentType,
  enviarMensagemSegura,
  calcularDelayResposta,
  downloadMediaMessage
) {
  const session = applicationSessions.get(chatId);
  if (!session) return false;
  const isImage = contentType === 'imageMessage';
  const isDocument = contentType === 'documentMessage';

  if (session.step === 'resume') {
    if (isDocument || isImage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, sock.updateMediaMessage ? { reuploadRequest: sock.updateMediaMessage } : {});
        if (buffer) {
          const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
          let filename = msg.message?.documentMessage?.fileName || msg.message?.imageMessage?.caption || '';
          let mimetype = msg.message?.documentMessage?.mimetype || msg.message?.imageMessage?.mimetype || 'application/pdf';
          if (isImage) {
            if (!mimetype || mimetype === 'application/pdf') mimetype = 'image/jpeg';
            const ext = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';
            if (!filename || filename === 'curriculo.pdf' || !/\.(jpg|jpeg|png|webp)$/i.test(filename)) filename = `curriculo.${ext}`;
          } else if (!filename) filename = 'curriculo.pdf';
          session.resume = {
            buffer: buf,
            filename: filename.trim() || 'curriculo.pdf',
            mimetype,
            base64: buf.toString('base64'),
          };

          await enviarMensagemSegura(sock, chatId, '📄 Recebi seu currículo! Estou analisando com IA, aguarde um momento...');

          let extracted = null;
          try {
            extracted = await extrairDadosCurriculo(buf, mimetype);
          } catch (e) {
            console.error('[WhatsApp] Erro ao analisar currículo com IA:', e?.message);
          }

          if (extracted && (extracted.fullName || extracted.email || extracted.phone)) {
            session.data.fullName = extracted.fullName || session.data.fullName || '';
            session.data.email = extracted.email || session.data.email || '';
            session.data.phone = extracted.phone || session.data.phone || '';
            session.data.city = extracted.city || session.data.city || '';
            session.data.jobInterest = extracted.jobInterest || session.data.jobInterest || '';
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
            await enviarMensagemSegura(sock, chatId, resposta);
            session.step = 'confirm_extracted';
            return true;
          }

          const resposta =
            'Currículo recebido! Não consegui ler os dados automaticamente.\n\n📷 *Dica:* Envie uma *foto* (imagem) da primeira página do currículo — a IA consegue analisar fotos. Ou informe seu *nome completo* para continuarmos manualmente.';
          await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
          await enviarMensagemSegura(sock, chatId, resposta);
          session.step = 'name';
          return true;
        }
      } catch (e) {
        console.error('[WhatsApp] Erro ao processar currículo:', e?.message);
      }
    }
    return true;
  }

  if (session.step === 'confirm_extracted') {
    if (textNorm.includes('sim') || textNorm.includes('s ') || textNorm === 's') {
      try {
        const defaultExt = (session.resume?.mimetype || '').startsWith('image/') ? (session.resume.mimetype === 'image/png' ? 'png' : session.resume.mimetype === 'image/webp' ? 'webp' : 'jpg') : 'pdf';
        const defaultName = (session.resume?.mimetype || '').startsWith('image/') ? `curriculo.${defaultExt}` : 'curriculo.pdf';
        await saveWhatsappApplication({
          chatId,
          fullName: session.data.fullName || 'Não informado',
          email: session.data.email || null,
          whatsappNumber: session.data.phone || chatId,
          city: session.data.city || null,
          jobInterest: session.data.jobInterest || 'Não especificado',
          resumeBase64: session.resume?.base64 || '',
          resumeFilename: session.resume?.filename || defaultName,
          resumeMimetype: session.resume?.mimetype || (defaultExt === 'pdf' ? 'application/pdf' : `image/${defaultExt}`),
        });
        const resposta =
          '🎉 *Candidatura registrada com sucesso!*\n\nSeus dados foram salvos e nossa equipe entrará em contato em breve.\n\nObrigada por se candidatar na EvoluxRH! 😊';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(sock, chatId, resposta);
        applicationSessions.delete(chatId);
        return true;
      } catch (error) {
        console.error('[WhatsApp] Erro ao salvar candidatura:', error);
        await enviarMensagemSegura(sock, chatId, 'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.');
        return true;
      }
    }
    if (textNorm.includes('não') || textNorm.includes('nao')) {
      const resposta = 'Sem problemas! Por favor, informe seu *nome completo* para preenchermos manualmente.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'name';
      session.data = {};
      return true;
    }
    return true;
  }

  if (session.step === 'name') {
    if (text && text.trim().length >= 2) {
      session.data.fullName = text.trim();
      const resposta = 'Ótimo! Agora preciso do seu *e-mail*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'email';
      return true;
    }
    const resposta = 'Por favor, informe seu nome completo.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
    return true;
  }

  if (session.step === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(text)) {
      session.data.email = text.trim();
      const resposta = 'Perfeito! Agora preciso do seu *número de telefone* (com DDD). Ex: 98999998888';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'phone';
      return true;
    }
    const resposta = 'Por favor, informe um e-mail válido.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
    return true;
  }

  if (session.step === 'phone') {
    const digits = (text || '').replace(/\D/g, '');
    if (digits.length >= 10) {
      session.data.phone = digits;
      const resposta = 'Ótimo! Agora preciso da sua *cidade*.';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'city';
      return true;
    }
    const resposta = 'Por favor, informe um número válido com DDD (mínimo 10 dígitos). Ex: 98999998888';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
    return true;
  }

  if (session.step === 'city') {
    if (text && text.trim().length >= 2) {
      session.data.city = text.trim();
      const resposta = 'Excelente! Por último, qual *área de interesse* ou vaga você tem interesse?';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'job';
      return true;
    }
    const resposta = 'Por favor, informe sua cidade.';
    await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
    await enviarMensagemSegura(sock, chatId, resposta);
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
    await enviarMensagemSegura(sock, chatId, resumo);
    session.step = 'confirm';
    return true;
  }

  if (session.step === 'confirm') {
    if (textNorm.includes('sim') || textNorm.includes('s ') || textNorm === 's') {
      try {
        const defaultExt = (session.resume?.mimetype || '').startsWith('image/') ? (session.resume.mimetype === 'image/png' ? 'png' : session.resume.mimetype === 'image/webp' ? 'webp' : 'jpg') : 'pdf';
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
        await enviarMensagemSegura(sock, chatId, resposta);
        applicationSessions.delete(chatId);
        return true;
      } catch (error) {
        console.error('[WhatsApp] Erro ao salvar candidatura:', error);
        const resposta = 'Desculpe, houve um erro ao salvar sua candidatura. Tente novamente mais tarde ou entre em contato conosco.';
        await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
        await enviarMensagemSegura(sock, chatId, resposta);
        return true;
      }
    }
    if (textNorm.includes('não') || textNorm.includes('nao')) {
      const resposta = 'Sem problemas! Qual dado você gostaria de corrigir? (nome, email, telefone, cidade ou vaga)';
      await new Promise((r) => setTimeout(r, calcularDelayResposta(resposta)));
      await enviarMensagemSegura(sock, chatId, resposta);
      session.step = 'correcting';
      return true;
    }
    return true;
  }

  return false;
}

module.exports = { createWhatsAppClient };
