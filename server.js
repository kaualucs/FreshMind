require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { GoogleGenAI } = require("@google/genai");
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const FC_TOKEN = (process.env.FRESHCHAT_API_KEY || process.env.FRESHCHAT_API_TOKEN || '').trim();
const FC_DOMAIN = (process.env.FRESHCHAT_DOMAIN || '').trim();
const FC_BASE = FC_DOMAIN
  ? `https://${FC_DOMAIN}/v2`
  : (process.env.FRESHCHAT_BASE_URL || 'https://api.freshchat.com/v2').replace(/\/$/, '');
const FC_APP_ID = (process.env.FRESHCHAT_APP_ID || '').trim();

if (!FC_TOKEN) console.warn('⚠️  Configure FRESHCHAT_API_KEY no .env');
console.log(`→ API base: ${FC_BASE}`);

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  function getGenAI(apiKeyIndex) {
    const keyNumber = apiKeyIndex || '1';
    const apiKey = process.env[`GEMINI_API_KEY_${keyNumber}`] || process.env.GEMINI_API_KEY;
    return new GoogleGenAI({ apiKey });
  }

// ── Google OAuth ──────────────────────────────────────────────────────────────

const TOKENS_FILE = path.join(__dirname, '.google-tokens.json');
const REDIRECT_URI = `http://localhost:${PORT}/auth/google/callback`;

// Aceita tanto o ID puro quanto a URL completa do Google Docs
const _rawDocId = (process.env.GOOGLE_DOC_ID || '').trim();
const GOOGLE_DOC_ID = _rawDocId.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ?? _rawDocId.split('/')[0];

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Carrega tokens salvos se existirem
if (fs.existsSync(TOKENS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    oauth2Client.setCredentials(saved);
    console.log('✓ Google Drive: tokens carregados');
  } catch (_) {}
}

oauth2Client.on('tokens', (tokens) => {
  const current = fs.existsSync(TOKENS_FILE)
    ? JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'))
    : {};
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({ ...current, ...tokens }));
});

function isGoogleAuthed() {
  const creds = oauth2Client.credentials;
  return !!(creds && (creds.access_token || creds.refresh_token));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Proxy helpers ────────────────────────────────────────────────────────────

async function fcFetch(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${FC_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  console.log(`[${res.status}] ${url}`);
  if (!res.ok) {
    console.error('Response body:', text.slice(0, 500));
    let detail = {};
    try { detail = JSON.parse(text); } catch(_) { detail = { raw: text.slice(0, 200) }; }
    const err = new Error(detail.message || detail.error_message || `Freshchat ${res.status}: ${res.statusText}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return JSON.parse(text);
}

// ── Freshchat routes ─────────────────────────────────────────────────────────

app.get('/api/conversations/:convId', async (req, res) => {
  try {
    const data = await fcFetch(`${FC_BASE}/conversations/${req.params.convId}`);
    console.log('Conversa campos:', JSON.stringify({
      id: data.id,
      conversation_id: data.conversation_id,
      app_id: data.app_id,
      channel_id: data.channel_id,
    }));
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

app.get('/api/conversations/:convId/messages', async (req, res) => {
  try {
    const { page = 1, items_per_page = 50 } = req.query;
    const appParam = FC_APP_ID ? `&app_id=${FC_APP_ID}` : '';

    let convId = req.params.convId;
    if (/^\d+$/.test(convId)) {
      const conv = await fcFetch(`${FC_BASE}/conversations/${convId}`);
      convId = conv.id || conv.conversation_id || convId;
      console.log(`Resolvido ID numérico → UUID: ${convId}`);
    }

    const data = await fcFetch(
      `${FC_BASE}/conversations/${convId}/messages?page=${page}&items_per_page=${items_per_page}${appParam}`
    );
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

app.get('/api/users/:userId', async (req, res) => {
  try {
    const data = await fcFetch(`${FC_BASE}/users/${req.params.userId}`);
    res.json(data);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

// ── Gemini analysis (streaming) ──────────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript obrigatório' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {

    const prompt = `
Contexto e Persona:
Você é um Analista Sênior de QA de Atendimento. Sua função é processar transcrições de suporte para extrair dados estruturados e operacionais, focando na resolução técnica e eliminando ruídos (cumprimentos e conversas irrelevantes).
Diretrizes de Classificação:
Ao identificar o TEMA, utilize estritamente uma das opções abaixo:
NFP, Agenda/Grades, Cadastros/Contratos, Wellhub/TotalPass, Treinos/Financeiro, CRM, Relatórios, Loja, Loja - Wellhub, Loja - TotalPass, Loja - GoNutri, Loja - App do Aluno, Loja - Notas fiscais, Loja - Pingo | Plug, Outros, Administrativo, Multiunidade, Migração, desktop e Web, Importação de planilha, Alteração cadastral, Reembolso Next Fit, CSM - Engajamento, CSM - Retenção, Equipamentos - Catracas ou Backup de dados.
Identificação de Ticket:
Sua tarefa é identificar se um ticket de atendimento foi ABERTO durante a conversa. Seja extremamente rigoroso.
Responda "Sim" APENAS se encontrar evidência explícita de que um ticket foi gerado, como:
- Uma mensagem do sistema ou agente contendo um link do Freshdesk (ex: "https://...freshdesk.com/...").
- Uma menção direta a um número de ticket ou protocolo (ex: "Ticket #12345").
- O uso de comandos como @APOIO VALIDAR TICKET.
Responda "Não" em todos os outros casos, incluindo:
- Se o agente apenas mencionou que "vai verificar" ou "vai reportar".
- Se houve apenas um encaminhamento interno não documentado.
- Se não houver uma evidência clara e textual da abertura do ticket na transcrição fornecida.
Sua resposta final nesse campo deve ser apenas "Sim" ou "Não".
Estrutura do Relatório (Markdown):
0. METADADOS DO ATENDIMENTO
Cliente: [Nome]
Agente: [Nome]
Link do Atendimento: [URL]
Data/Horário: [Data e Hora]
Tema: [Escolher da lista fornecida]
Ticket Aberto? [Sim/Não]
1. DOR DO CLIENTE
Descreva o problema central, o impacto no uso do sistema e o nível de urgência apresentado pelo cliente.
2. RESOLUÇÃO DO AGENTE (SISTEMA)
Diagnóstico: O que foi identificado como causa.
Ações no Sistema: Lista numerada com o passo a passo exato das configurações, cliques ou alterações que o agente realizou para resolver o caso.
Resultado Final: Como o atendimento foi encerrado.

TRANSCRIÇÃO:
${transcript}`;

    const { apiKeyIndex } = req.body;
    const dynamicGenAI = getGenAI(apiKeyIndex);
    const result = await dynamicGenAI.models.generateContentStream({
    model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    for await (const chunk of result) {
      const chunkText = chunk.text;
      if (chunkText) {
        res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.error('Gemini error:', e.message);
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
});

// ── Batch Process ──────────────────────────────────────────────────────────────
app.post('/api/batch-process', async (req, res) => {
  const { convId } = req.body;
  if (!convId) return res.status(400).json({ error: 'ID da conversa ausente' });

  try {
       // 1. Busca a conversa (converte ID numérico se necessário)
    let convIdOriginal = convId;
    if (/^\d+$/.test(convIdOriginal)) {
      const convTemp = await fcFetch(`${FC_BASE}/conversations/${convIdOriginal}`);
      convIdOriginal = convTemp.id || convTemp.conversation_id || convIdOriginal;
      console.log(`Resolvido ID numérico → UUID: ${convIdOriginal}`);
    }

    const conv = await fcFetch(`${FC_BASE}/conversations/${convIdOriginal}`);
    const msgsRes = await fcFetch(`${FC_BASE}/conversations/${convIdOriginal}/messages?page=1&items_per_page=50&app_id=${FC_APP_ID}`);
    const msgs = msgsRes.messages || [];
    msgs.sort((a, b) => new Date(a.created_time || 0) - new Date(b.created_time || 0));

    // 2. Monta a transcrição
    const transcript = msgs.map(m => {
      const type = (m.actor_type || '');
      const label = type === 'agent' ? '[Agente]' : (type === 'system' || type === 'bot' ? '[Sistema]' : '[Cliente]');
      const time = m.created_time ? new Date(m.created_time).toLocaleString('pt-BR') : '';
      const content = (m.message_parts || []).map(p => p?.text?.content).filter(Boolean).join(' ');
      return `${label} – ${time}: ${content}`;
    }).join('\n');

    // 3. Meta (cabeçalho para o Google Docs)
    // Busca o nome do contato (usuário)
    let contactName = conv.user_name || null;
    if (!contactName && conv.user_id) {
      try {
        const userRes = await fcFetch(`${FC_BASE}/users/${conv.user_id}`);
        contactName = [userRes.first_name, userRes.last_name].filter(Boolean).join(' ') || userRes.email || conv.user_id;
      } catch (_) {
        contactName = conv.user_id;
      }
    }
    contactName = contactName || '—';

    // Busca o nome do agente
    let agentName = conv.assigned_agent_name || null;
    if (!agentName && conv.assigned_agent_id) {
      try {
        const agentRes = await fcFetch(`${FC_BASE}/agents/${conv.assigned_agent_id}`);
        agentName = [agentRes.first_name, agentRes.last_name].filter(Boolean).join(' ') || agentRes.email || conv.assigned_agent_id;
      } catch (_) {
        agentName = conv.assigned_agent_id;
      }
    }
    agentName = agentName || '—';

    // Link do atendimento
    const convLink = `https://sistemanextfit.freshchat.com/a/${FC_APP_ID}/inbox/0/conversation/${conv.id || conv.conversation_id}`;

    const meta = `Contato: ${contactName}\nAgente: ${agentName}\nInício: ${new Date(conv.created_time).toLocaleString('pt-BR')}\nAtendimento: ${convLink}`;
    
    // 4. Análise com Gemini (não-streaming) – CORRIGIDO
    const prompt = `Contexto e Persona:
Você é um Analista Sênior de QA de Atendimento. Sua função é processar transcrições de suporte para extrair dados estruturados e operacionais, focando na resolução técnica e eliminando ruídos (cumprimentos e conversas irrelevantes).
Diretrizes de Classificação:
Ao identificar o TEMA, utilize estritamente uma das opções abaixo:
NFP, Agenda/Grades, Cadastros/Contratos, Wellhub/TotalPass, Treinos/Financeiro, CRM, Relatórios, Loja, Loja - Wellhub, Loja - TotalPass, Loja - GoNutri, Loja - App do Aluno, Loja - Notas fiscais, Loja - Pingo | Plug, Outros, Administrativo, Multiunidade, Migração, desktop e Web, Importação de planilha, Alteração cadastral, Reembolso Next Fit, CSM - Engajamento, CSM - Retenção, Equipamentos - Catracas ou Backup de dados.
Identificação de Ticket:
Sua tarefa é identificar se um ticket de atendimento foi ABERTO durante a conversa. Seja extremamente rigoroso.
Responda "Sim" APENAS se encontrar evidência explícita de que um ticket foi gerado, como:
- Uma mensagem do sistema ou agente contendo um link do Freshdesk (ex: "https://...freshdesk.com/...").
- Uma menção direta a um número de ticket ou protocolo (ex: "Ticket #12345").
- O uso de comandos como @APOIO VALIDAR TICKET.
Responda "Não" em todos os outros casos, incluindo:
- Se o agente apenas mencionou que "vai verificar" ou "vai reportar".
- Se houve apenas um encaminhamento interno não documentado.
- Se não houver uma evidência clara e textual da abertura do ticket na transcrição fornecida.
Sua resposta final nesse campo deve ser apenas "Sim" ou "Não".
Estrutura do Relatório (Markdown):
0. METADADOS DO ATENDIMENTO
Cliente: [Nome]
Agente: [Nome]
Link do Atendimento: [URL]
Data/Horário: [Data e Hora]
Tema: [Escolher da lista fornecida]
Ticket Aberto? [Sim/Não]
1. DOR DO CLIENTE
Descreva o problema central, o impacto no uso do sistema e o nível de urgência apresentado pelo cliente.
2. RESOLUÇÃO DO AGENTE (SISTEMA)
Diagnóstico: O que foi identificado como causa.
Ações no Sistema: Lista numerada com o passo a passo exato das configurações, cliques ou alterações que o agente realizou para resolver o caso.
Resultado Final: Como o atendimento foi encerrado.

TRANSCRIÇÃO:
${transcript}`;

    const result = await genAI.models.generateContent({
    model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const analysis = result.text;

    // 5. Salva no Google Docs
    if (!GOOGLE_DOC_ID) return res.status(500).json({ error: 'GOOGLE_DOC_ID não configurado' });
    const docs = google.docs({ version: 'v1', auth: oauth2Client });
    const doc = await docs.documents.get({ documentId: GOOGLE_DOC_ID });
    const bodyContent = doc.data.body.content;
    const endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;

    const now = new Date().toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    const ticket = extractTicket(analysis);
    const tema = extractTema(analysis);
    const block = [
      '',
      '════════════════════════════════════════════════════════════',
      `ATENDIMENTO — ${now}`,
      '════════════════════════════════════════════════════════════',
      '',
      '[ INFORMAÇÕES DA CONVERSA ]',
      meta,
      `Tema: ${tema}`,
      `Ticket Aberto? ${ticket}`,
      '',
      '────────────────────────────────────────────────────────────',
      'DOR DO CLIENTE',
      '────────────────────────────────────────────────────────────',
      '',
      extractDor(analysis),
      '',
      '────────────────────────────────────────────────────────────',
      'RESOLUÇÃO DO AGENTE',
      '────────────────────────────────────────────────────────────',
      '',
      extractResolucao(analysis),
      '',
    ].join('\n');

    await docs.documents.batchUpdate({
      documentId: GOOGLE_DOC_ID,
      requestBody: {
        requests: [{ insertText: { location: { index: endIndex }, text: block } }],
      },
    });

    console.log(`✓ Atendimento ${convId} processado e adicionado ao Google Doc (${GOOGLE_DOC_ID})`);
    res.json({ ok: true });

  } catch (e) {
    console.error('Erro no processamento:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Google Drive: status de autenticação ──────────────────────────────────────

app.get('/api/google/status', (req, res) => {
  res.json({ authed: isGoogleAuthed() });
});

// ── Google OAuth: iniciar fluxo ───────────────────────────────────────────────

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/documents'],
  });
  res.redirect(url);
});

// ── Google OAuth: callback ────────────────────────────────────────────────────

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<script>window.opener.postMessage({googleAuth:'error',msg:'${error}'},'*');window.close();</script>`);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
    console.log('✓ Google Drive autenticado com sucesso');
    res.send(`<script>window.opener.postMessage({googleAuth:'ok'},'*');window.close();</script>`);
  } catch (e) {
    res.send(`<script>window.opener.postMessage({googleAuth:'error',msg:'${e.message}'},'*');window.close();</script>`);
  }
});

// ── Google Docs: append atendimento ──────────────────────────────────────────

app.post('/api/google/upload', async (req, res) => {
  if (!isGoogleAuthed()) return res.status(401).json({ error: 'Não autenticado no Google' });

  const { meta, analysis, transcript } = req.body;
  if (!analysis) return res.status(400).json({ error: 'analysis obrigatório' });

  if (!GOOGLE_DOC_ID) return res.status(500).json({ error: 'GOOGLE_DOC_ID não configurado no .env' });

  try {
    const docs = google.docs({ version: 'v1', auth: oauth2Client });

    // Busca o doc para saber o índice final
    const doc = await docs.documents.get({ documentId: GOOGLE_DOC_ID });
    const bodyContent = doc.data.body.content;
    const endIndex = bodyContent[bodyContent.length - 1].endIndex - 1;

    const now = new Date().toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    // Monta o bloco do atendimento bem estruturado
    const block = [
      '',
      '════════════════════════════════════════════════════════════',
      `ATENDIMENTO — ${now}`,
      '════════════════════════════════════════════════════════════',
      '',
      '[ INFORMAÇÕES DA CONVERSA ]',
      meta || '',
      '',
      '────────────────────────────────────────────────────────────',
      'DOR DO CLIENTE',
      '────────────────────────────────────────────────────────────',
      '',
      extractDor(analysis),
      '',
      '────────────────────────────────────────────────────────────',
      'RESOLUÇÃO DO AGENTE',
      '────────────────────────────────────────────────────────────',
      '',
      extractResolucao(analysis),
      '',
    ].join('\n');

    await docs.documents.batchUpdate({
      documentId: GOOGLE_DOC_ID,
      requestBody: {
        requests: [{ insertText: { location: { index: endIndex }, text: block } }],
      },
    });

    console.log(`✓ Atendimento appendado no Google Doc (${GOOGLE_DOC_ID})`);
    res.json({ ok: true, docId: GOOGLE_DOC_ID });
  } catch (e) {
    console.error('Docs append error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Novas funções de extração baseadas nos títulos exatos do prompt
function extractDor(analysis) {
  const match = analysis.match(/1\.\s*DOR DO CLIENTE\s*\n([\s\S]*?)(?=\n2\.\s*RESOLUÇÃO DO AGENTE)/i);
  return match ? match[1].trim() : analysis.trim();
}

function extractResolucao(analysis) {
  const match = analysis.match(/2\.\s*RESOLUÇÃO DO AGENTE[^\n]*\n([\s\S]*)/i);
  return match ? match[1].trim() : '';
}
function extractTema(analysis) {
  const match = analysis.match(/Tema:\s*(.+)/i);
  return match ? match[1].trim() : 'Não identificado';
}

function extractTicket(analysis) {
  const match = analysis.match(/Ticket Aberto\?\s*(Sim|Não)/i);
  return match ? match[1].trim() : 'Não identificado';
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✓ Freshchat Viewer rodando em http://localhost:${PORT}`);
});
