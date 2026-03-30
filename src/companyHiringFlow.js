const { cfg } = require('./config');

const DEFAULT_LUIZA_PHONE = '5551993796131';

/** Frases e padrões que indicam empresa / contratação (evita conflito com candidatos). */
const COMPANY_PHRASES = [
  'sou empresa',
  'minha empresa',
  'nossa empresa',
  'represento uma empresa',
  'represento uma companhia',
  'preciso contratar',
  'quero contratar',
  'contratar funcionarios',
  'contratar profissionais',
  'contratar pessoas',
  'contratacao de pessoal',
  'busco profissionais',
  'buscando profissionais',
  'precisamos contratar',
  'queremos contratar',
  'servico de recrutamento',
  'servico de rh',
  'terceirizar rh',
  'rh para minha empresa',
  'sou do rh',
  'setor de rh',
  'parceria comercial',
  'fechar parceria',
  'divulgar vaga',
  'anunciar vaga',
  'vagas para minha empresa',
  'recrutamento para empresa',
  'selecao de pessoal',
  'empresa precisa de',
  'empresa esta contratando',
  'somos uma empresa',
];

function getLuizaPhoneDigits() {
  const raw = cfg.LUIZA_WHATSAPP_PHONE || process.env.LUIZA_WHATSAPP_PHONE || DEFAULT_LUIZA_PHONE;
  const digits = String(raw).replace(/\D/g, '');
  return digits || DEFAULT_LUIZA_PHONE.replace(/\D/g, '');
}

function getLuizaWhatsappUrl() {
  return `https://wa.me/${getLuizaPhoneDigits()}`;
}

/**
 * @param {string} textNorm texto em minúsculas, sem acentos (mesmo padrão do bot)
 */
function matchesCompanyHiringIntent(textNorm) {
  if (!textNorm || typeof textNorm !== 'string') return false;
  if (COMPANY_PHRASES.some((p) => textNorm.includes(p))) return true;

  const candidato =
    textNorm.includes('me candidat') ||
    textNorm.includes('minha candidatura') ||
    textNorm.includes('enviar curriculo') ||
    textNorm.includes('quero trabalhar') ||
    textNorm.includes('quero uma vaga') ||
    textNorm.includes('gostaria de me candidatar');
  if (candidato) return false;

  if (
    textNorm.includes('empresa') &&
    (textNorm.includes('contrat') || textNorm.includes('recrut') || textNorm.includes('seleca'))
  ) {
    return true;
  }
  return false;
}

function getLuizaRedirectMessage() {
  const url = getLuizaWhatsappUrl();
  return (
    'Entendi que você é *empresa* ou precisa de apoio para *contratar* e recrutar pessoas.\n\n' +
    'Este atendimento automático é focado em *candidatos*. Para falar com a nossa equipe comercial da melhor forma, a *Luiza* vai te atender no WhatsApp profissional dela:\n\n' +
    `${url}\n\n` +
    'Toque no link para abrir a conversa com a Luiza.'
  );
}

/** Instrução injetada no prompt da IA (URL dinâmica). */
function getInstrucaoEmpresasContratantes() {
  const url = getLuizaWhatsappUrl();
  return (
    '\n\n[EMPRESAS / CONTRATAÇÃO] Se a pessoa disser que representa uma empresa, quer contratar, precisa de RH/recrutamento/seleção para a empresa, parceria comercial ou anunciar vagas como empregadora: ' +
    'explique com empatia que este canal é voltado a candidatos. Direcione para a *Luiza*, que faz o atendimento comercial e profissional. ' +
    `Inclua na resposta o link exato do WhatsApp dela: ${url}. Seja objetiva e acolhedora.`
  );
}

module.exports = {
  matchesCompanyHiringIntent,
  getLuizaRedirectMessage,
  getLuizaWhatsappUrl,
  getLuizaPhoneDigits,
  getInstrucaoEmpresasContratantes,
};
