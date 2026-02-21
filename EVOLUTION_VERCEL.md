# EvoluxRH Bot: API na Vercel + Evolution API

Este projeto pode rodar de três formas:

1. **Baileys (local)** – `npm start` – conexão direta com WhatsApp via QR Code.
2. **Evolution API + webhook local** – `npm run webhook` – servidor local recebe o webhook (use ngrok para expor a URL à Evolution).
3. **Evolution API + Vercel** – deploy na Vercel; a Evolution envia o webhook para a URL do projeto.

## Rodar webhook localmente (sem Vercel)

1. Configure o `.env` com `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` (e as demais variáveis: OpenAI, Supabase).
2. Inicie o servidor: `npm run webhook` (porta padrão: 3333).
3. Exponha a URL para a internet (ex.: [ngrok](https://ngrok.com) – `ngrok http 3333`).
4. Na Evolution API, configure o webhook com a URL exposta: `https://seu-ngrok.ngrok.io/api/webhook`.
5. Ative **webhookBase64: true** e o evento **MESSAGES_UPSERT**.

Assim o bot funciona 100% via Evolution API, sem Baileys e sem Vercel.

## Deploy na Vercel

1. Faça push do projeto para um repositório Git (GitHub, GitLab ou Bitbucket).
2. Acesse [vercel.com](https://vercel.com), importe o repositório e faça o deploy.
3. Nas **Variáveis de Ambiente** do projeto na Vercel, configure:
   - `OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` (ou GROQ)
   - `SUPABASE_URL`, `SUPABASE_KEY`
   - `EVOLUTION_API_URL` – URL base da sua Evolution API (ex: `https://sua-evolution.com`)
   - `EVOLUTION_API_KEY` – API Key da Evolution API
   - `EVOLUTION_INSTANCE` – Nome da instância WhatsApp na Evolution

4. Após o deploy, a URL do webhook será:  
   **`https://seu-projeto.vercel.app/api/webhook`**

## Configurar webhook na Evolution API

1. Crie e conecte uma instância na Evolution API (QR Code pela Evolution).
2. Configure o webhook para receber mensagens:

   **Método:** `POST`  
   **URL:** `https://seu-projeto.vercel.app/api/webhook`

   **Eventos:** ative pelo menos:
   - `MESSAGES_UPSERT` (mensagens recebidas)

   **Recomendado:** ative `webhookBase64: true` para que imagens e documentos (ex.: currículos) venham em base64 e o bot possa processar.

3. Exemplo de configuração via API da Evolution (ajuste a URL e a instância):

```bash
curl -X POST "https://sua-evolution.com/webhook/set/SUA_INSTANCIA" \
  -H "Content-Type: application/json" \
  -H "apikey: SUA_API_KEY" \
  -d '{
    "enabled": true,
    "url": "https://seu-projeto.vercel.app/api/webhook",
    "webhookByEvents": false,
    "webhookBase64": true,
    "events": ["MESSAGES_UPSERT"]
  }'
```

4. No painel da Evolution API (se existir tela de webhook), informe a mesma URL e marque o evento **MESSAGES_UPSERT** e a opção de enviar mídia em base64.

## Teste rápido

- **GET** `https://seu-projeto.vercel.app/api/webhook`  
  Deve retornar `{ "ok": true, "service": "EvoluxRH Bot", "mode": "evolution-webhook", ... }`.

- Envie uma mensagem para o número conectado na Evolution; o bot deve responder usando a mesma lógica (IA, candidatura, #assumir / #pausa).

## Resumo de variáveis (.env ou Vercel)

| Variável              | Obrigatória | Descrição                          |
|-----------------------|------------|-------------------------------------|
| OPENAI_API_KEY        | Sim        | Chave OpenAI (ou GROQ)              |
| OPENAI_API_URL        | Sim*       | Base da API (* ou GROQ_API_URL)     |
| SUPABASE_URL          | Sim        | URL do projeto Supabase             |
| SUPABASE_KEY          | Sim        | Chave service role Supabase         |
| EVOLUTION_API_URL     | Sim (Vercel) | URL base da Evolution API         |
| EVOLUTION_API_KEY     | Sim (Vercel) | API Key da Evolution               |
| EVOLUTION_INSTANCE    | Sim (Vercel) | Nome da instância na Evolution     |

Com isso, o WhatsApp fica na Evolution API e o cérebro do bot (IA + candidaturas) roda na Vercel via webhook.
