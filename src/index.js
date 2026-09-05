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

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const LOG_CHANNEL_ID =
  process.env.LOG_CHANNEL_ID?.trim() || null;

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
  Number.parseInt(
    process.env.CONTEXT_WINDOW_SECONDS || "45",
    10
  )
);

const MAX_IMAGE_BYTES = Math.max(
  100000,
  Number.parseInt(
    process.env.MAX_IMAGE_BYTES || "8000000",
    10
  )
);

// Modelo que já funcionou no seu bot.
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.6-flash";

// ============================================================
// VALIDAÇÃO DAS VARIÁVEIS
// ============================================================

if (!DISCORD_TOKEN) {
  console.error(
    "ERRO: DISCORD_TOKEN nao foi configurado."
  );
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.warn(
    "AVISO: GEMINI_API_KEY nao foi configurada. " +
      "A moderacao por regras continuara funcionando, " +
      "mas a analise por IA ficara desativada."
  );
}

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
    })
  : null;

// ============================================================
// CLIENTE DISCORD
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
  ],
});

// ============================================================
// MEMÓRIA / CACHE
// ============================================================

// Histórico curto por usuário.
const userHistory = new Map();

// Evita processar a mesma mensagem simultaneamente.
const MENSAGENS_PROCESSANDO = new Set();

// Cache de imagens analisadas durante a execução atual.
const CACHE_IMAGES = new Map();

// ============================================================
// TERMOS PROIBIDOS
// ============================================================

const HARD_BLOCK_PATTERNS = [
  /\bhitler\b/i,
  /\badolf\b/i,
  /\bnazi\b/i,
  /\bnazista\b/i,
  /\bnazistas\b/i,
  /\bnazismo\b/i,
  /\bnacional[\s-]?socialismo\b/i,
  /\bnacional[\s-]?socialista\b/i,
  /\bterceiro[\s-]?reich\b/i,
  /\bthird[\s-]?reich\b/i,
  /\bgestapo\b/i,
  /\bwehrmacht\b/i,
  /\bholocausto\b/i,
  /\bholocaust\b/i,
  /\bantisemitismo\b/i,
  /\banti[\s-]?semitismo\b/i,
];

const CONTEXT_TERMS = [
  "hitler",
  "adolf",
  "nazi",
  "nazista",
  "nazistas",
  "nazismo",
  "nacional socialismo",
  "nacional-socialismo",
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

// ============================================================
// NORMALIZAÇÃO DE TEXTO
// ============================================================

function normalizeText(input = "") {
  return String(input)
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

// ============================================================
// DETECÇÃO DETERMINÍSTICA
// ============================================================

function hasHardBlock(text) {
  const normalized = normalizeText(text);
  const compact = compactText(text);

  // Detecta nomes mesmo com espaços entre as letras.
  if (
    /h\s*i\s*t\s*l\s*e\s*r/i.test(normalized)
  ) {
    return true;
  }

  if (
    /n\s*a\s*z\s*i/i.test(normalized)
  ) {
    return true;
  }

  for (const pattern of HARD_BLOCK_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  // Detecta tentativas de burlar o filtro.
  const compactPatterns = [
    /hitler/,
    /adolf/,
    /nazi/,
    /nazista/,
    /nazistas/,
    /nazismo/,
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

  return compactPatterns.some((pattern) =>
    pattern.test(compact)
  );
}

function hasContextTerm(text) {
  const normalized = normalizeText(text);

  return CONTEXT_TERMS.some((term) =>
    normalized.includes(term)
  );
}

// ============================================================
// HISTÓRICO DO USUÁRIO
// ============================================================

function rememberMessage(message) {
  if (
    !message.guildId ||
    !message.author?.id
  ) {
    return;
  }

  const key =
    `${message.guildId}:${message.author.id}`;

  const now = Date.now();

  const cutoff =
    now - CONTEXT_WINDOW_SECONDS * 1000;

  const old = userHistory.get(key) || [];

  const fresh = old
    .filter(
      (item) => item.timestamp >= cutoff
    )
    .slice(-(CONTEXT_MESSAGES - 1));

  fresh.push({
    content: message.content || "",
    timestamp: now,
  });

  userHistory.set(key, fresh);
}

function getRecentContext(message) {
  const key =
    `${message.guildId}:${message.author.id}`;

  const items =
    userHistory.get(key) || [];

  return items
    .map((item) => item.content)
    .filter(Boolean)
    .join("\n");
}

// ============================================================
// CONFIGURAÇÃO DE CANAIS / CARGOS
// ============================================================

function shouldModerateChannel(message) {
  if (!message.guildId) {
    return false;
  }

  if (MODERATION_CHANNEL_IDS.size === 0) {
    return true;
  }

  return MODERATION_CHANNEL_IDS.has(
    message.channelId
  );
}

function hasBypassRole(message) {
  if (BYPASS_ROLE_IDS.size === 0) {
    return false;
  }

  if (!message.member?.roles?.cache) {
    return false;
  }

  return message.member.roles.cache.some(
    (role) => BYPASS_ROLE_IDS.has(role.id)
  );
}

// ============================================================
// EXCLUSÃO DE MENSAGEM
// ============================================================

function canDelete(message) {
  return Boolean(
    message.guild?.members?.me?.permissions?.has(
      PermissionsBitField.Flags.ManageMessages
    )
  );
}

async function safeDelete(message) {
  console.log(
    `[DELETE] deletable=${message.deletable} ` +
      `manageMessages=${canDelete(message)}`
  );

  if (!message.deletable) {
    console.error(
      "[DELETE] Discord informou que a mensagem nao pode ser apagada."
    );
    return false;
  }

  if (!canDelete(message)) {
    console.error(
      "[DELETE] O bot nao possui ManageMessages."
    );
    return false;
  }

  try {
    await message.delete();

    console.log(
      `[DELETE] Mensagem apagada: ${message.id}`
    );

    return true;
  } catch (error) {
    console.error(
      "[DELETE] Falha ao apagar mensagem:",
      error?.message || error
    );

    return false;
  }
}

// ============================================================
// LOG DE MODERAÇÃO
// ============================================================

async function sendLog(
  message,
  reason,
  deleted
) {
  if (!LOG_CHANNEL_ID) {
    return;
  }

  try {
    const channel =
      await client.channels.fetch(
        LOG_CHANNEL_ID
      );

    if (!channel?.isTextBased()) {
      return;
    }

    const safeReason =
      String(reason).slice(0, 800);

    const safeContent =
      String(
        message.content || "[sem texto]"
      ).slice(0, 900);

    await channel.send({
      content:
        `🚨 **MODERAÇÃO ANTINAZISMO**\n` +
        `**Usuário:** ${message.author.tag} (${message.author.id})\n` +
        `**Canal:** <#${message.channelId}>\n` +
        `**Apagada:** ${
          deleted
            ? "sim"
            : "não (sem permissão)"
        }\n` +
        `**Motivo:** ${safeReason}\n` +
        `**Texto:** ${safeContent}`,
      allowedMentions: {
        parse: [],
      },
    });
  } catch (error) {
    console.error(
      "[LOG] Falha ao enviar log:",
      error?.message || error
    );
  }
}

// ============================================================
// ANÁLISE DE TEXTO COM GEMINI
// ============================================================

async function analyzeTextWithGemini(
  text,
  context
) {
  if (!ai || !text.trim()) {
    return false;
  }

  const prompt = `
Voce e um moderador de um servidor Discord.

O servidor possui uma regra EXTREMAMENTE ESTRITA:
qualquer referencia clara a Hitler, nazismo,
nacional-socialismo, propaganda nazista,
glorificacao do nazismo, saudacoes nazistas,
simbolos nazistas ou tentativa de conduzir
a conversa para esse tema deve ser removida.

Considere tambem o contexto recente do mesmo usuario.

IMPORTANTE:
- Retorne SOMENTE JSON valido.
- Formato exato:
  {"block":true}
  ou
  {"block":false}
- Se houver referencia direta ou indireta clara
  ao tema proibido, use true.
- Nao invente conexoes.
- Conversas normais sem relacao ao tema devem
  retornar false.

MENSAGEM ATUAL:
${text}

CONTEXTO RECENTE:
${context || "[nenhum]"}
`;

  try {
    const response =
      await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          temperature: 0,
          responseMimeType:
            "application/json",
        },
      });

    const raw =
      response.text?.trim() || "";

    const parsed =
      JSON.parse(raw);

    return parsed?.block === true;
  } catch (error) {
    console.error(
      "[GEMINI TEXTO] Falhou:",
      error?.message || error
    );

    return false;
  }
}

// ============================================================
// ANEXOS DE IMAGEM
// ============================================================

function getImageAttachments(message) {
  return [
    ...message.attachments.values(),
  ].filter((attachment) => {
    const type =
      attachment.contentType || "";

    const name =
      attachment.name || "";

    return (
      type.startsWith("image/") ||
      /\.(jpg|jpeg|png|gif|webp|bmp|avif)$/i.test(
        name
      )
    );
  });
}

// ============================================================
// ANÁLISE DE IMAGEM COM GEMINI
// ============================================================

async function analyzeImageWithGemini(
  attachment
) {
  if (!ai) {
    return {
      block: false,
      skipped: true,
      reason: "Gemini nao configurado",
    };
  }

  if (
    attachment.size &&
    attachment.size > MAX_IMAGE_BYTES
  ) {
    return {
      block: false,
      skipped: true,
      reason: "imagem grande demais",
    };
  }

  try {
    // Baixa a imagem.
    const response =
      await fetch(attachment.url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ao baixar imagem`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const buffer =
      Buffer.from(arrayBuffer);

    if (
      buffer.length > MAX_IMAGE_BYTES
    ) {
      return {
        block: false,
        skipped: true,
        reason: "imagem grande demais",
      };
    }

    // Hash da imagem para cache.
    const hash = createHash("sha256")
      .update(buffer)
      .digest("hex");

    if (CACHE_IMAGES.has(hash)) {
      console.log(
        `[CACHE] Imagem encontrada: ${hash}`
      );

      return CACHE_IMAGES.get(hash);
    }

    const mimeType =
      attachment.contentType ||
      response.headers.get(
        "content-type"
      ) ||
      "image/jpeg";

    const prompt = `
Voce e o filtro visual de um servidor Discord
com REGRA EXTREMAMENTE ESTRITA contra nazismo.

Analise a imagem.

Retorne SOMENTE JSON valido:
{"block":true}
ou
{"block":false}

Use block=true se a imagem:

- retrata Hitler ou uma representacao claramente
  identificavel dele;
- apresenta propaganda nazista;
- glorifica ou celebra o nazismo;
- apresenta simbolos nazistas usados claramente
  nesse contexto;
- apresenta uma saudacao nazista claramente
  identificavel pelo contexto;
- apresenta material visual de propaganda
  nazista;
- possui texto que claramente promove ou glorifica
  Hitler ou o nazismo;
- representa claramente uma imitacao intencional
  de Hitler ou de propaganda nazista.

Nao bloqueie somente porque a imagem e:
- historica;
- militar;
- politica;
- relacionada a guerra;

sem relacao clara com o nazismo.

Nao descreva a imagem.

Retorne somente:
{"block":true}
ou
{"block":false}
`;

    const result =
      await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            inlineData: {
              data: buffer.toString(
                "base64"
              ),
              mimeType,
            },
          },
          prompt,
        ],
        config: {
          temperature: 0,
          responseMimeType:
            "application/json",
        },
      });

    const raw =
      result.text?.trim() || "";

    const parsed =
      JSON.parse(raw);

    const finalResult = {
      block:
        parsed?.block === true,
      skipped: false,
    };

    CACHE_IMAGES.set(
      hash,
      finalResult
    );

    return finalResult;
  } catch (error) {
    console.error(
      `[GEMINI IMAGEM] Falhou (${
        attachment.name ||
        attachment.id
      }):`,
      error?.message || error
    );

    return {
      block: false,
      skipped: true,
      reason: "erro na analise",
    };
  }
}

// ============================================================
// MODERAÇÃO PRINCIPAL
// ============================================================

async function moderateMessage(
  message
) {
  if (!message.guildId) {
    return;
  }

  if (message.author?.bot) {
    return;
  }

  if (!shouldModerateChannel(message)) {
    return;
  }

  if (hasBypassRole(message)) {
    return;
  }

  // Evita processamento duplicado.
  if (MENSAGENS_PROCESSANDO.has(message.id)) {
    return;
  }

  MENSAGENS_PROCESSANDO.add(
    message.id
  );

  try {
    const recentContext =
      getRecentContext(message);

    const currentText =
      message.content || "";

    // --------------------------------------------------------
    // 1. BLOQUEIO DIRETO
    // --------------------------------------------------------

    if (hasHardBlock(currentText)) {
      const deleted =
        await safeDelete(message);

      await sendLog(
        message,
        "palavra ou variacao proibida detectada",
        deleted
      );

      return;
    }

    // --------------------------------------------------------
    // 2. TENTATIVA DE MONTAR TERMOS EM PARTES
    // --------------------------------------------------------

    const combined =
      `${recentContext}\n${currentText}`;

    if (
      hasContextTerm(combined) &&
      hasHardBlock(
        compactText(combined)
      )
    ) {
      const deleted =
        await safeDelete(message);

      await sendLog(
        message,
        "tentativa de montar termo proibido em partes",
        deleted
      );

      return;
    }

    // --------------------------------------------------------
    // 3. ANÁLISE SEMÂNTICA DO TEXTO
    // --------------------------------------------------------

    if (
      currentText.trim() &&
      ai
    ) {
      const aiBlock =
        await analyzeTextWithGemini(
          currentText,
          recentContext
        );

      if (aiBlock) {
        const deleted =
          await safeDelete(message);

        await sendLog(
          message,
          "tema proibido detectado por analise contextual da IA",
          deleted
        );

        return;
      }
    }

    // --------------------------------------------------------
    // 4. ANÁLISE VISUAL
    // --------------------------------------------------------

    const images =
      getImageAttachments(message);

    for (const image of images) {
      const result =
        await analyzeImageWithGemini(
          image
        );

      if (result.block) {
        const deleted =
          await safeDelete(message);

        await sendLog(
          message,
          "imagem relacionada ao tema proibido detectada por IA",
          deleted
        );

        return;
      }
    }
  } finally {
    MENSAGENS_PROCESSANDO.delete(
      message.id
    );
  }
}

// ============================================================
// BOT ONLINE
// ============================================================

client.once(
  Events.ClientReady,
  (readyClient) => {
    console.log(
      `Bot online: ${readyClient.user.tag}`
    );

    console.log(
      `Modelo Gemini: ${GEMINI_MODEL}`
    );

    console.log(
      `Moderacao: ${
        MODERATION_CHANNEL_IDS.size > 0
          ? `somente ${MODERATION_CHANNEL_IDS.size} canal(is)`
          : "todos os canais"
      }`
    );

    console.log(
      `Gemini: ${
        ai ? "configurado" : "desativado"
      }`
    );
  }
);

// ============================================================
// NOVAS MENSAGENS
// ============================================================

client.on(
  Events.MessageCreate,
  async (message) => {
    try {
      if (message.author?.bot) {
        return;
      }

      await moderateMessage(
        message
      );

      rememberMessage(
        message
      );
    } catch (error) {
      console.error(
        "Erro no evento MessageCreate:",
        error?.message || error
      );
    }
  }
);

// ============================================================
// MENSAGENS EDITADAS
// ============================================================

client.on(
  Events.MessageUpdate,
  async (
    _oldMessage,
    newMessage
  ) => {
    try {
      if (newMessage.author?.bot) {
        return;
      }

      await moderateMessage(
        newMessage
      );

      rememberMessage(
        newMessage
      );
    } catch (error) {
      console.error(
        "Erro no evento MessageUpdate:",
        error?.message || error
      );
    }
  }
);

// ============================================================
// TRATAMENTO DE ERROS
// ============================================================

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "unhandledRejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "uncaughtException:",
      error
    );
  }
);

// ============================================================
// LOGIN
// ============================================================

client
  .login(DISCORD_TOKEN)
  .then(() => {
    console.log(
      "Login do Discord iniciado."
    );
  })
  .catch((error) => {
    console.error(
      "ERRO ao fazer login no Discord:",
      error?.message || error
    );

    process.exit(1);
  });
