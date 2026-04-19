/**
 * Funil fixo alinhado ao fluxo: saudação → classificar (candidato x empresa) →
 * comercial (Luiza) ou candidatura (currículo → IA → confirmação → Supabase).
 */
const { matchesCompanyHiringIntent, getLuizaRedirectMessage } = require('./companyHiringFlow');

const CANDIDATE_KEYWORDS = [
  'quero me candidatar',
  'gostaria de me candidatar',
  'fazer minha candidatura',
  'enviar meu curriculo',
  'enviar curriculo',
  'quero trabalhar',
  'quero uma vaga',
  'sou candidat',
  'sou uma candidata',
  'procuro emprego',
  'procuro vaga',
  'estou procurando emprego',
  'candidato',
  'candidata',
  'candidatura',
];

function matchesCandidateIntent(textNorm) {
  if (!textNorm || typeof textNorm !== 'string') return false;
  if (CANDIDATE_KEYWORDS.some((k) => textNorm.includes(k))) return true;
  if (textNorm === 'candidato' || textNorm === 'candidata') return true;
  return false;
}

function getIntroMessage() {
  return 'Olá! Sou a Iza da EvoluxRH 😊';
}

function getClassificationQuestion() {
  return (
    'Para eu te direcionar do jeito certo: você deseja *se candidatar* a uma vaga ou você representa uma *empresa*?\n\n' +
    'Responda *CANDIDATO* ou *EMPRESA*.'
  );
}

function getMediaNeedsClassificationMessage() {
  return (
    'Recebi um arquivo ou imagem. Antes de analisar, preciso saber: você quer *se candidatar* (responda *CANDIDATO*) ou é *empresa* (responda *EMPRESA*)?'
  );
}

function getRepromptClassification() {
  return 'Não entendi. Responda *CANDIDATO* se quiser uma vaga, ou *EMPRESA* se for contratação ou atendimento comercial.';
}

function getRequestCvMessage() {
  return 'Perfeito! Envie seu *currículo* em PDF, DOCX ou uma *foto* da primeira página do currículo.';
}

/**
 * @param {object} opts
 * @param {string} opts.textNorm
 * @param {boolean} opts.hasBody
 * @param {boolean} opts.hasMedia
 * @param {boolean} opts.awaitingClassification
 * @param {(msgs: string[]) => Promise<void>} opts.sendMessages sequência de textos (já com delays na implementação do caller ou aqui)
 */
function matchesCompanyChoice(textNorm) {
  if (!textNorm || typeof textNorm !== 'string') return false;
  const t = textNorm.trim();
  if (t === 'empresa') return true;
  if (/^sou\s+uma\s+empresa/.test(t)) return true;
  return matchesCompanyHiringIntent(textNorm);
}

async function runRecruitmentFunnelTurn({ textNorm, hasBody, hasMedia, awaitingClassification, sendMessages }) {
  const company = hasBody && matchesCompanyChoice(textNorm);
  const candidate = hasBody && matchesCandidateIntent(textNorm);

  if (awaitingClassification) {
    if (company) {
      await sendMessages([getLuizaRedirectMessage()]);
      return { handled: true, awaitingClassification: false, startApplication: false };
    }
    if (candidate) {
      await sendMessages([getRequestCvMessage()]);
      return { handled: true, awaitingClassification: false, startApplication: true };
    }
    if (hasMedia && !hasBody) {
      await sendMessages([getRepromptClassification()]);
      return { handled: true, awaitingClassification: true, startApplication: false };
    }
    await sendMessages([getRepromptClassification()]);
    return { handled: true, awaitingClassification: true, startApplication: false };
  }

  // Primeiro contato (ou novo ciclo): mídia sem texto conta como “ainda não classificado”
  if (hasMedia && !hasBody) {
    await sendMessages([getIntroMessage(), getMediaNeedsClassificationMessage()]);
    return { handled: true, awaitingClassification: true, startApplication: false };
  }

  if (!hasBody) {
    return { handled: false, awaitingClassification: false, startApplication: false };
  }

  if (company) {
    await sendMessages([getIntroMessage(), getLuizaRedirectMessage()]);
    return { handled: true, awaitingClassification: false, startApplication: false };
  }

  if (candidate) {
    await sendMessages([getIntroMessage(), getRequestCvMessage()]);
    return { handled: true, awaitingClassification: false, startApplication: true };
  }

  await sendMessages([getIntroMessage(), getClassificationQuestion()]);
  return { handled: true, awaitingClassification: true, startApplication: false };
}

async function deliverWithDelays(messages, calcularDelayResposta, sendOne) {
  for (const m of messages) {
    if (!m) continue;
    await new Promise((r) => setTimeout(r, calcularDelayResposta(m)));
    await sendOne(m);
  }
}

module.exports = {
  matchesCandidateIntent,
  getIntroMessage,
  getClassificationQuestion,
  getRequestCvMessage,
  runRecruitmentFunnelTurn,
  deliverWithDelays,
};
