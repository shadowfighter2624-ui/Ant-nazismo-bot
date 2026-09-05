import "dotenv/config";
import { createHash } from "node:crypto";
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Events,
} from "discord.js";
import { GoogleGenAI } from "@google/genai";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID?.trim() || null;
const MODERATION_CHANNEL_IDS = new Set(
  (process.env.MODERATION_CHANNEL_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);
const BYPASS_ROLE_IDS = new Set(
  (process.env.BYPASS_ROLE_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

const CONTEXT_MESSAGES = Math.max(
  2,
  Number.parseInt(process.env.CONTEXT_MESSAGES || "8", 10)
);
const CONTEXT_WINDOW_SECONDS = Math.max(
  10,
  Number.parseInt(process.env.CONTEXT_WINDOW_SECONDS || "45", 10)
);
const MAX_IMAGE_BYTES = Math.max(
  100000,
  Number.parseInt(process.env.MAX_IMAGE_BYTES || "8000000", 10)
);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

if (!DISCORD_TOKEN) {
  console.error("ERRO: DISCORD_TOKEN nao foi configurado.");
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.warn(
    "AVISO: GEMINI_API_KEY nao foi configurada. O bot funcionara para texto por regras, mas nao conseguira analisar visualmente imagens."
  );
}

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// Historico curto em memoria: userId -> [{content, timestamp}]
const userHistory = new Map();

const CACHE_IMAGENS = new Map();
const MENSAGENS_PROCESSANDO = new Set();
// Palavras e expressoes de alta confianca.
// O normalizador abaixo tambem remove acentos, pontuacao e caracteres invisiveis.
const HARD_BLOCK_PATTERNS = [
  /\bhitler\b/i,
  /\badolf\b/i,
  /\bnazis(?:ta|tas|mo)?\b/i,
  /\bnazismo\b/i,
  /\bnazi\b/i,
  /\nazi(?:s|sta|stas|sm|smo)?\b/i,
  /\bnacional[\s-]?social(?:ismo|ista|istas)?\b/i,
  /\bterceiro[\s-]?reich\b/i,
  /\bthird[\s-]?reich\b/i,
  /\bss\b/i,
  /\bwehrmacht\b/i,
  /\bgestapo\b/i,
  /\bholocausto\b/i,
  /\bholocaust\b/i,
  /\bantisemitismo\b/i,
  /\banti[\s-]?semitismo\b/i,
];

// Simbolos/saudacoes podem aparecer sem texto.
// Nao incluimos o simbolo literal no codigo para evitar que o proprio
// repositorio reproduza propaganda. O detector visual do Gemini cuida disso.
const CONTEXT_TERMS = [
  "hitler",
  "adolf",
  "nazi",
  "nazista",
  "nazistas",
  "nazismo",
  "nacional socialismo",
  "terceiro reich",
  "third reich",
  "gestapo",
  "wehrmacht",
  "holocausto",
  "holocaust",
  "antisemitismo",
  "antissemitismo",
  "saudacao",
  "simbolo",
  "propaganda",
];

function normalizeText(input = "") {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/[3€]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(input = "") {
  return normalizeText(input).replace(/\s+/g, "");
}

function hasHardBlock(text) {
  const normalized = normalizeText(text);
  const compact = compactText(text);

  // Regras com espacos/pontuacao entre letras.
  if (/\bh\s*i\s*t\s*l\s*e\s*r\b/i.test(normalized)) return true;
  if (/\bn\s*a\s*z\s*i\b/i.test(normalized)) return true;

  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  // Pega tentativas como h.i.t.l.e.r ou n-a-z-i-s-m-o.
  const compactPatterns = [
    /hitler/,
    /adolf/,
    /nazista/,
    /nazistas/,
    /nazismo/,
    /nazi/,
    /nacionalsocial/,
    /terceiroreich/,
    /thirdreich/,
    /gestapo/,
    /wehrmacht/,
    /holocausto/,
    /holocaust/,
    /antisemitismo/,
    /antissemitismo/,
  ];

  return compactPatterns.some((pattern) => pattern.test(compact));
}

function hasContextTerm(text) {
  const normalized = normalizeText(text);
  return CONTEXT_TERMS.some((term) => normalized.includes(term));
}

function rememberMessage(message) {
  if (!message.guildId || !message.author?.id) return;

  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  const cutoff = now - CONTEXT_WINDOW_SECONDS * 1000;

  const old = userHistory.get(key) || [];
  const fresh = old
    .filter((item) => item.timestamp >= cutoff)
    .slice(-(CONTEXT_MESSAGES - 1));

  fresh.push({
    content: message.content || "",
    timestamp: now,
  });

  userHistory.set(key, fresh);
}

function getRecentContext(message) {
  const key = `${message.guildId}:${message.author.id}`;
  const items = userHistory.get(key) || [];
  return items.map((x) => x.content).filter(Boolean).join("\n");
}

function shouldModerateChannel(message) {
  if (!message.guildId) return false;
  if (MODERATION_CHANNEL_IDS.size === 0) return true;
  return MODERATION_CHANNEL_IDS.has(message.channelId);
}

function hasBypassRole(message) {
  if (BYPASS_ROLE_IDS.size === 0) return false;
  if (!message.member?.roles?.cache) return false;
  return message.member.roles.cache.some((role) =>
    BYPASS_ROLE_IDS.has(role.id)
  );
}

function canDelete(message) {
  return Boolean(
    message.guild?.members?.me?.permissions?.has(
      PermissionsBitField.Flags.ManageMessages
    )
  );
}

async function safeDelete(message) {
  const deletable = message.deletable;
  const manageMessages = canDelete(message);

  console.log(
    `Diagnostico apagar mensagem: deletable=${deletable}, manageMessages=${manageMessages}, messageId=${message.id}`
  );

  if (!deletable) {
    console.error(
      `NAO FOI POSSIVEL APAGAR: message.deletable=false, messageId=${message.id}`
    );
    return false;
  }

  if (!manageMessages) {
    console.error(
      `NAO FOI POSSIVEL APAGAR: bot sem permissao Manage Messages, messageId=${message.id}`
    );
    return false;
  }

  try {
    await message.delete();

    console.log(
      `Mensagem apagada com sucesso: ${message.id}`
    );

    return true;
  } catch (error) {
    if (error?.code === 10008) {
      console.log(
        `Mensagem ${message.id} ja nao existe. Considerando como apagada.`
      );

      return true;
    }

    console.error(
      "Falha ao apagar mensagem:",
      error?.message || error
    );

    return false;
  }
async function sendLog(message, reason, deleted) {

  if (!LOG_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel?.isTextBased()) return;

    const safeReason = String(reason).slice(0, 800);
    const safeContent = String(message.content || "[sem texto]").slice(0, 900);

    await channel.send({
      content:
        `🚨 **MODERAÇÃO ANTINAZISMO**\n` +
        `**Usuário:** ${message.author.tag} (${message.author.id})\n` +
        `**Canal:** <#${message.channelId}>\n` +
        `**Apagada:** ${deleted ? "sim" : "não (sem permissão)"}\n` +
        `**Motivo:** ${safeReason}\n` +
        `**Texto:** ${safeContent}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("Falha ao enviar log:", error?.message || error);
  }
}

async function analyzeTextWithGemini(text, context) {
  if (!ai || !text.trim()) return false;

  const prompt = `
Voce e um moderador de um servidor Discord.
O servidor possui uma regra EXTREMAMENTE ESTRITA: qualquer referencia a Hitler,
nazismo, nacional-socialismo, propaganda nazista, saudacoes nazistas,
simbolos nazistas, glorificacao ou tentativa de conduzir a conversa para
esses assuntos deve ser removida.

Classifique a mensagem considerando tambem o contexto recente do mesmo usuario.

IMPORTANTE:
- Retorne SOMENTE JSON valido.
- Formato exato: {"block":true} ou {"block":false}
- Se houver referencia direta ou indireta clara ao tema proibido, use true.
- Nao invente conexoes. Se for uma conversa normal sem relacao ao tema, use false.

MENSAGEM ATUAL:
${text}

CONTEXTO RECENTE:
${context || "[nenhum]"}
`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    });

    const raw = response.text?.trim() || "";
    const parsed = JSON.parse(raw);
    return parsed?.block === true;
  } catch (error) {
    console.error("Gemini texto falhou:", error?.message || error);
    return false;
  }
}

function getImageAttachments(message) {
  return [...message.attachments.values()].filter((attachment) => {
    const type = (attachment.contentType || "").toLowerCase();
    const name = (attachment.name || "").toLowerCase();

    return (
      type.startsWith("image/") ||
      /\.(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(name)
    );
  });
}

async function analyzeImageWithGemini(attachment) {
  if (!ai) {
    return {
      block: false,
      skipped: true,
      reason: "Gemini não configurado",
    };
  }

  if (attachment.size && attachment.size > MAX_IMAGE_BYTES) {
    return {
      block: false,
      skipped: true,
      reason: "imagem grande demais",
    };
  }

  try {
    const response = await fetch(attachment.url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ao baixar imagem`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_IMAGE_BYTES) {
      return {
        block: false,
        skipped: true,
        reason: "imagem grande demais",
      };
    }

    // Identifica a imagem pelo conteúdo real dela.
    // Assim, a mesma imagem pode ser reconhecida mesmo
    // que o Discord gere uma URL diferente.
    const imageHash = createHash("sha256")
      .update(buffer)
      .digest("hex");

    // Se essa imagem já foi analisada anteriormente,
    // não precisamos chamar o Gemini novamente.
    if (CACHE_IMAGES.has(imageHash)) {
      const cached = CACHE_IMAGES.get(imageHash);

      console.log(
        `Cache da imagem encontrado: block=${cached.block}`
      );

      return {
        block: cached.block,
        skipped: false,
        cacheHit: true,
      };
    }

    const mimeType =
      attachment.contentType ||
      response.headers.get("content-type") ||
      "image/jpeg";

    const prompt = `
Você e o filtro visual antinazismo de um servidor Discord.
A regra de moderacao e EXTREMAMENTE ESTRITA.

Analise a imagem cuidadosamente e responda SOMENTE com JSON valido:

{"block":true}

ou

{"block":false}

BLOQUEIE (block=true) se QUALQUER uma destas condicoes for verdadeira:

1. A imagem mostra Adolf Hitler, mesmo que:
   - esteja sozinho;
   - esteja em uma foto historica;
   - nao exista nenhum simbolo nazista visivel;
   - esteja usando roupas comuns;
   - esteja apenas fazendo um retrato normal;
   - apareca parcialmente, desde que seja claramente identificavel.

2. A imagem mostra QUALQUER pessoa fazendo uma saudacao nazista ou um gesto claramente identificavel como saudacao nazista, mesmo que:
   - a pessoa nao seja Hitler;
   - esteja sozinha;
   - esteja em uma fotografia, desenho, meme ou montagem;
   - nao existam outros simbolos nazistas na imagem.

3. A imagem mostra QUALQUER simbolo, emblema, bandeira, marca, insignia ou representacao visual claramente associada ao nazismo/nacional-socialismo.

4. A imagem mostra propaganda nazista, material de propaganda, cartazes, bandeiras, uniformes, emblemas ou composicoes que promovam, glorifiquem ou celebrem o nazismo.

5. A imagem mostra uma pessoa claramente caracterizada ou representada como Hitler, incluindo imitacao visual claramente intencional de sua aparencia ou personagem.

6. A imagem mostra uma pessoa usando uma combinacao de gesto, simbolos, roupas, texto, cenografia ou outros elementos que deixe clara uma intencao nazista ou uma imitacao/apologia nazista.

7. A imagem contem texto, desenho, meme ou montagem que claramente promova, celebre, glorifique ou represente o nazismo ou Hitler.

IMPORTANTE:
- Nao exija que Hitler esteja acompanhado de simbolos nazistas.
- Uma imagem de Hitler sozinha deve resultar em block=true.
- Uma saudacao nazista feita por qualquer pessoa deve resultar em block=true.
- Um simbolo nazista claramente identificavel deve resultar em block=true.
- Considere tambem desenhos, ilustracoes, memes e montagens.
- Nao bloqueie simplesmente porque uma pessoa levantou o braco em uma situacao comum. Deve existir contexto visual claro de saudacao nazista.
- Nao invente conexoes que nao estejam presentes na imagem.
- Retorne SOMENTE o JSON. Nao explique a decisao.

RESPONDA AGORA SOMENTE:

{"block":true}

ou

{"block":false}
`;

    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          inlineData: {
            data: buffer.toString("base64"),
            mimeType,
          },
        },
        prompt,
      ],
      config: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    });

    const raw = result.text?.trim() || "";
    const parsed = JSON.parse(raw);

    const decision = {
      block: parsed?.block === true,
    };

    // Guarda somente analises concluidas com sucesso.
    // Se o Gemini falhar, nao colocamos nada no cache.
    CACHE_IMAGES.set(imageHash, decision);

    // Limita o cache para evitar crescimento infinito de memoria.
    if (CACHE_IMAGES.size > 5000) {
      const oldestKey = CACHE_IMAGES.keys().next().value;

      if (oldestKey) {
        CACHE_IMAGES.delete(oldestKey);
      }
    }

    return {
      ...decision,
      skipped: false,
      cacheHit: false,
    };
  } catch (error) {
    console.error(
      `Gemini imagem falhou (${attachment.name || attachment.id}):`,
      error?.message || error
    );

    return {
      block: false,
      skipped: true,
      reason: "erro na analise",
      cacheHit: false,
    };
  }
async function moderateMessage(message) {
  if (!message.guildId) return;
  if (message.author?.bot) return;
  if (!shouldModerateChannel(message)) return;

  // Por padrao nao existe bypass.
  // Se voce preencher BYPASS_ROLE_IDS, esses cargos ficam fora da moderacao.
  if (hasBypassRole(message)) return;

  const recentContext = getRecentContext(message);
  const currentText = message.content || "";

  // Primeiro bloqueio deterministico: rapido e nao depende de API.
  if (hasHardBlock(currentText)) {
    const deleted = await safeDelete(message);
    await sendLog(message, "palavra/variacao proibida detectada", deleted);
    return;
  }

  // Se o conjunto recente do usuario estiver montando um termo, bloqueia.
  const combined = `${recentContext}\n${currentText}`;
  if (hasContextTerm(combined) && hasHardBlock(compactText(combined))) {
    const deleted = await safeDelete(message);
    await sendLog(message, "tentativa de montar termo proibido em partes", deleted);
    return;
  }

  // Analise semantica do texto: pega tentativas menos obvias.
  if (currentText.trim() && ai) {
    const aiBlock = await analyzeTextWithGemini(currentText, recentContext);
    if (aiBlock) {
      const deleted = await safeDelete(message);
      await sendLog(message, "analise contextual por IA", deleted);
      return;
    }
  }

  // Analise visual dos anexos.
  const images = getImageAttachments(message);

  for (const image of images) {
  console.log(
    `Imagem encontrada: ${image.name || image.id} (${image.contentType || "tipo desconhecido"})`
  );

  const result = await analyzeImageWithGemini(image);

  console.log(
  `Resultado da imagem ${image.name || image.id}: block=${result.block}, skipped=${result.skipped}, cacheHit=${result.cacheHit || false}`
);

  if (result.block) {
      const deleted = await safeDelete(message);
      await sendLog(
        message,
        "imagem relacionada ao tema proibido detectada por IA",
        deleted
      );
      return;
    }
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Bot online: ${readyClient.user.tag}`);
  console.log(`Modelo Gemini: ${GEMINI_MODEL}`);
  console.log(
    `Moderacao: ${
      MODERATION_CHANNEL_IDS.size
        ? `somente ${MODERATION_CHANNEL_IDS.size} canal(is)`
        : "todos os canais"
    }`
  );
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.author?.bot) {
      await moderateMessage(message);
      rememberMessage(message);
    }
  } catch (error) {
    console.error("Erro no evento MessageCreate:", error);
  }
});

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    // Mensagens editadas tambem passam pelo filtro.
    if (!newMessage.author?.bot) {
      await moderateMessage(newMessage);
    }
  } catch (error) {
    console.error("Erro no evento MessageUpdate:", error);
  }
});

process.on("unhandledRejection", (error) => {
  console.error("unhandledRejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
});

client.login(DISCORD_TOKEN);
