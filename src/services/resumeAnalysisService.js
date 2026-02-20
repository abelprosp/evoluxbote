/**
 * Serviço para analisar currículo (imagem ou PDF) com IA e extrair dados estruturados.
 * Usa a mesma API configurada em OPENAI_* / GROQ_* (vision para imagem, chat para texto de PDF).
 */
const axios = require('axios');
const { cfg } = require('../config');

// pdf-parse 2.x: classe PDFParse, método getText() retorna { text: string }
const pdfParseModule = require('pdf-parse');
const PDFParseClass =
  pdfParseModule.PDFParse ||
  (pdfParseModule.default && pdfParseModule.default.PDFParse) ||
  (typeof pdfParseModule.default === 'function' ? pdfParseModule.default : null);

const apiUrl = (cfg.OPENAI_API_URL || process.env.OPENAI_API_URL || '').replace(/\/$/, '');
const apiKey = cfg.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const chatPath = (cfg.AI_CHAT_PATH || '/chat/completions').replace(/^\//, '');
const model = cfg.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const timeout = cfg.AI_TIMEOUT_MS || 30000;

const PROMPT_EXTRACAO = `Você é um assistente que extrai dados de currículos.

Extraia do currículo as informações abaixo e responda APENAS com um JSON válido, sem markdown, sem explicação, no seguinte formato (use null para campos não encontrados):
{"nome_completo": "string ou null", "email": "string ou null", "telefone": "string ou null (apenas dígitos ou formato (XX) XXXXX-XXXX)", "cidade": "string ou null", "area_interesse": "string ou null (área profissional, cargo desejado ou última função)"}

Regras:
- nome_completo: nome completo do candidato
- email: e-mail válido
- telefone: número com DDD (Brasil), apenas dígitos ou formato legível
- cidade: cidade de residência
- area_interesse: área de atuação, cargo desejado ou último cargo

Responda somente o JSON, nada mais.`;

/**
 * Extrai texto de buffer PDF (pdf-parse 2.x: PDFParse + getText()).
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractTextFromPdf(buffer) {
  if (typeof PDFParseClass !== 'function') {
    throw new Error('pdf-parse: PDFParse não encontrado. Use pdf-parse@2.x.');
  }
  const parser = new PDFParseClass({ data: buffer });
  try {
    const result = await parser.getText();
    const text = result?.text ?? (result?.pages && result.pages.map((p) => p?.text).filter(Boolean).join('\n'));
    if (parser.destroy) await parser.destroy().catch(() => {});
    return (text || '').trim();
  } catch (e) {
    if (parser.destroy) await parser.destroy().catch(() => {});
    throw e;
  }
}

/**
 * Chama a API de chat com texto (para PDF) e pede extração em JSON.
 * @param {string} textoCurriculo
 * @returns {Promise<object|null>}
 */
async function extrairDadosDeTexto(textoCurriculo) {
  if (!apiUrl || !apiKey) {
    console.warn('[ResumeAnalysis] OPENAI_API_URL/OPENAI_API_KEY não configurados');
    return null;
  }
  if (!textoCurriculo || textoCurriculo.length < 10) return null;

  const url = `${apiUrl}/${chatPath}`.replace(/([^:]\/)\/+/g, '$1');
  try {
    const { data } = await axios.post(
      url,
      {
        model,
        messages: [
          { role: 'system', content: PROMPT_EXTRACAO },
          { role: 'user', content: `Texto do currículo:\n\n${textoCurriculo.slice(0, 12000)}` },
        ],
        max_tokens: 500,
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout,
      }
    );
    const content = data?.choices?.[0]?.message?.content?.trim() || '';
    return parseJsonExtraction(content);
  } catch (err) {
    console.error('[ResumeAnalysis] Erro ao extrair dados do texto:', err?.message || err);
    return null;
  }
}

/**
 * Analisa imagem de currículo com Vision e extrai dados em JSON.
 * @param {Buffer} bufferImagem
 * @param {string} mime - ex: image/jpeg, image/png
 * @returns {Promise<object|null>}
 */
async function extrairDadosDeImagem(bufferImagem, mime = 'image/jpeg') {
  if (!apiUrl || !apiKey) {
    console.warn('[ResumeAnalysis] OPENAI_API_URL/OPENAI_API_KEY não configurados');
    return null;
  }

  const base64Image = bufferImagem.toString('base64');
  const url = `${apiUrl}/${chatPath}`.replace(/([^:]\/)\/+/g, '$1');

  try {
    const { data } = await axios.post(
      url,
      {
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Esta imagem é um currículo. ${PROMPT_EXTRACAO}`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mime};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
        temperature: 0.1,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: Math.max(timeout, 60000),
      }
    );
    const content = data?.choices?.[0]?.message?.content?.trim() || '';
    return parseJsonExtraction(content);
  } catch (err) {
    console.error('[ResumeAnalysis] Erro ao extrair dados da imagem:', err?.message || err);
    return null;
  }
}

/**
 * Tenta parsear uma string como JSON da extração (tolera blocos de código).
 * @param {string} content
 * @returns {object|null}
 */
function parseJsonExtraction(content) {
  if (!content) return null;
  let str = content.trim();
  // Remove markdown code block se a IA enviar ```json ... ```
  str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const jsonMatch = str.match(/\{[\s\S]*\}/);
  if (jsonMatch) str = jsonMatch[0];
  try {
    const obj = JSON.parse(str);
    if (obj && typeof obj === 'object') {
      const fullName = obj.nome_completo || obj.nome || null;
      const email = obj.email || null;
      const phone = normalizePhone(obj.telefone || obj.phone);
      const city = obj.cidade || obj.cidade_residencia || null;
      const jobInterest = obj.area_interesse || obj.area || obj.cargo || null;
      if (fullName || email || phone) {
        return { fullName, email, phone, city, jobInterest };
      }
    }
  } catch (_) {}
  return null;
}

function normalizePhone(value) {
  if (value == null || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

/**
 * Converte a primeira página do PDF em imagem (PNG) para análise por visão.
 * Requer o pacote pdf-img-convert (e canvas). Se não estiver instalado ou falhar, retorna null.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Buffer|null>}
 */
async function pdfFirstPageToImage(pdfBuffer) {
  try {
    const pdf2img = require('pdf-img-convert');
    const output = await pdf2img.convert(pdfBuffer, {
      base64: false,
      scale: 2,
      page_numbers: [1],
    });
    if (output && output.length > 0 && output[0]) {
      const first = output[0];
      return Buffer.isBuffer(first) ? first : Buffer.from(first);
    }
    return null;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.warn('[ResumeAnalysis] Conversão PDF->imagem falhou:', err?.message || err);
    }
    return null;
  }
}

/**
 * Analisa currículo (imagem ou PDF) e retorna dados extraídos pela IA.
 * @param {Buffer} buffer - conteúdo do arquivo
 * @param {string} mimetype - ex: image/jpeg, application/pdf
 * @returns {Promise<object|null>} { fullName, email, phone, city, jobInterest } ou null
 */
async function extrairDadosCurriculo(buffer, mimetype = 'application/pdf') {
  if (!buffer || !Buffer.isBuffer(buffer)) return null;
  const mime = (mimetype || '').toLowerCase();

  if (mime.startsWith('image/')) {
    return extrairDadosDeImagem(buffer, mime);
  }
  if (mime === 'application/pdf' || mimetype === 'application/pdf') {
    try {
      const texto = await extractTextFromPdf(buffer);
      const len = (texto || '').length;
      console.log('[ResumeAnalysis] PDF: texto extraído =', len, 'caracteres');
      // PDF com algum texto: tentar extrair via IA (aceita a partir de 10 chars)
      if (texto && len >= 10) {
        const dados = await extrairDadosDeTexto(texto);
        if (dados) return dados;
      }
      // PDF escaneado (pouco ou nenhum texto): converter primeira página em imagem se possível
      const imgBuffer = await pdfFirstPageToImage(buffer);
      if (imgBuffer) {
        return extrairDadosDeImagem(imgBuffer, 'image/png');
      }
      if (len === 0) {
        console.warn('[ResumeAnalysis] PDF sem texto (escaneado). Peça ao usuário para enviar uma *foto* do currículo.');
      }
      return null;
    } catch (err) {
      console.error('[ResumeAnalysis] Erro ao ler PDF:', err?.message || err);
      return null;
    }
  }
  // DOCX etc.: não temos parser de texto aqui; poderia usar mammoth no futuro
  return null;
}

module.exports = {
  extrairDadosCurriculo,
  extrairDadosDeImagem,
  extrairDadosDeTexto,
  extractTextFromPdf,
};
