const axios = require('axios');
const { cfg } = require('./config');
const { getSupabase } = require('./db/supabase');
const { getActiveJobs } = require('./services/jobsService');

// Configuração para chamadas à API (suporta OpenAI, GROQ e outras APIs compatíveis)
const apiUrl = cfg.OPENAI_API_URL || process.env.OPENAI_API_URL || 'https://api.openai.com/v1';
const apiKey = cfg.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const chatPath = cfg.AI_CHAT_PATH || '/chat/completions';
const timeout = cfg.AI_TIMEOUT_MS || 30000;

// Cliente HTTP para chamadas à API
const httpClient = axios.create({
  baseURL: apiUrl,
  timeout: timeout,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  }
});

// Armazenar contexto das conversas (em memória - pode migrar para Supabase depois)
const conversas = new Map();

// Prompt do assistente - IA EvoluxRH (estilo Diamond)
const PROMPT_SISTEMA = `Você é a Iza, assistente virtual da EvoluxRH, uma empresa de recrutamento e seleção.

Seu papel é ajudar candidatos de forma humana, próxima e personalizada, orientando sobre vagas disponíveis e coletando informações para candidaturas.

Você deve:
- Responder dúvidas sobre vagas disponíveis
- Orientar sobre o processo de candidatura
- Coletar dados do candidato (nome, email, telefone, cidade, área de interesse)
- Processar currículos enviados via WhatsApp
- Ser sempre educada, profissional e empática

Quando o candidato quiser se candidatar:
1. Solicite o currículo (PDF, DOCX ou imagem)
2. Após receber o currículo, colete: nome completo, email, telefone, cidade e área de interesse
3. Confirme os dados antes de finalizar
4. Salve tudo no sistema

Seja sempre natural e conversacional, nunca como um questionário robótico.`;

/**
 * Obtém ou cria contexto da conversa
 */
function obterContexto(chatId, nome, telefone) {
  if (!conversas.has(chatId)) {
    conversas.set(chatId, {
      mensagens: [],
      nome: nome || 'Candidato',
      telefone: telefone || chatId,
      estagio: 'inicial',
      qualificado: false
    });
  }
  return conversas.get(chatId);
}

/**
 * Busca vagas ativas no Supabase e formata para o contexto
 */
async function buscarVagasParaContexto() {
  try {
    const jobs = await getActiveJobs();
    if (!jobs || jobs.length === 0) {
      return 'Não há vagas disponíveis no momento.';
    }
    
    let info = `\n\n[VAGAS DISPONÍVEIS - ${jobs.length} vaga(s)]\n\n`;
    jobs.slice(0, 10).forEach((job, index) => {
      info += `${index + 1}. ${job.title || 'Vaga'}\n`;
      if (job.location) info += `   Local: ${job.location}\n`;
      if (job.description) {
        const desc = job.description.substring(0, 150);
        info += `   Descrição: ${desc}...\n`;
      }
      info += `\n`;
    });
    
    info += `Use essas informações para responder perguntas sobre vagas. Se o candidato perguntar sobre vagas específicas, mencione as opções disponíveis.`;
    
    return info;
  } catch (error) {
    console.error('[ChatService] Erro ao buscar vagas:', error);
    return '';
  }
}

/**
 * Gera resposta com OpenAI (estilo Diamond)
 */
async function gerarResposta(contexto, mensagemCliente, descricaoImagem = null) {
  try {
    // Busca vagas para contexto
    const infoVagas = await buscarVagasParaContexto();
    
    // Construir histórico de mensagens
    const mensagens = [
      {
        role: 'system',
        content: PROMPT_SISTEMA
          .replace('{nome}', contexto.nome)
          .replace('{telefone}', contexto.telefone)
          .replace('{estagio}', contexto.estagio)
          .replace('{qualificado}', contexto.qualificado ? 'Sim' : 'Não')
      }
    ];

    // Adicionar histórico da conversa (últimas 10 mensagens)
    const historico = contexto.mensagens.slice(-10);
    historico.forEach(msg => {
      mensagens.push({
        role: msg.role,
        content: msg.content
      });
    });

    // Construir mensagem do usuário
    let conteudoMensagem = mensagemCliente;
    if (descricaoImagem) {
      conteudoMensagem = mensagemCliente 
        ? `${mensagemCliente}\n\n[Imagem enviada: ${descricaoImagem}]`
        : `[Imagem enviada: ${descricaoImagem}]`;
    }
    
    // Adicionar informações de vagas
    if (infoVagas) {
      conteudoMensagem += infoVagas;
    }

    // Adicionar mensagem atual do cliente
    mensagens.push({
      role: 'user',
      content: conteudoMensagem
    });

    // Chamar API (OpenAI/GROQ/compatível)
    console.log(`[ChatService] Chamando API: ${apiUrl}${chatPath}, modelo: ${cfg.OPENAI_MODEL || 'gpt-4o-mini'}`);
    const response = await httpClient.post(chatPath, {
      model: cfg.OPENAI_MODEL || 'gpt-4o-mini',
      messages: mensagens,
      temperature: 0.7,
      max_tokens: 500
    });

    const resposta = response.data?.choices?.[0]?.message?.content?.trim() || 
                     response.data?.message?.content?.trim() || 
                     'Desculpe, não consegui gerar uma resposta.';
    
    console.log(`[ChatService] ✅ Resposta gerada (${resposta.length} chars)`);
    
    // Atualizar histórico
    contexto.mensagens.push(
      { role: 'user', content: conteudoMensagem },
      { role: 'assistant', content: resposta }
    );

    return resposta;
  } catch (error) {
    console.error('[ChatService] ❌ Erro ao gerar resposta:', error?.message || error);
    if (error?.response) {
      console.error('[ChatService] Status:', error.response.status);
      console.error('[ChatService] Data:', error.response.data);
    }
    return 'Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente em alguns instantes.';
  }
}

/**
 * Analisa imagem usando API compatível (GPT-4 Vision ou similar)
 */
async function analisarImagem(bufferImagem, legenda = '') {
  try {
    const base64Image = bufferImagem.toString('base64');
    
    const response = await httpClient.post(chatPath, {
      model: cfg.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: legenda 
                ? `O candidato enviou esta imagem com a seguinte legenda: "${legenda}". Analise a imagem e descreva o que você vê de forma objetiva. Se houver texto na imagem (como em um currículo), transcreva-o.`
                : 'Analise esta imagem e descreva o que você vê de forma objetiva. Se houver texto na imagem (como em um currículo), transcreva-o.'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 300
    });

    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error('Erro ao analisar imagem:', error?.message || error);
    return null;
  }
}

module.exports = {
  obterContexto,
  gerarResposta,
  analisarImagem,
  conversas
};
