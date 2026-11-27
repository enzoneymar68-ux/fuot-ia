const MODEL = "@cf/zai-org/glm-4.7-flash";
const VISION = "@cf/meta/llama-3.2-11b-vision-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const AUDIO_MODEL = "@cf/openai/whisper-large-v3-turbo";

const MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_FILE_SIZE = 7 * 1024 * 1024;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60_000;
const requestHistory = new Map();

const SYSTEM_PROMPT = `Você é a Fuot IA, uma assistente útil, clara e confiável.
Responda no idioma usado pelo usuário. Para perguntas simples, seja direta; para tarefas complexas, explique com detalhes e organização.
Não invente fatos, fontes, resultados de pesquisa ou capacidades. Quando não souber, diga isso.
Ajude com estudos, programação, escrita, análise e tarefas gerais. Em código, entregue soluções completas e explique pontos importantes quando necessário.`;

const ALLOWED_ORIGINS = new Set([
  "https://enzoneymar68-ux.github.io",
  "http://localhost:8788",
  "http://127.0.0.1:8788"
]);

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://enzoneymar68-ux.github.io";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function makeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function outputText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.response === "string") return result.response;
  if (typeof result.generated_text === "string") return result.generated_text;
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.choices)) {
    const choice = result.choices[0];
    return choice?.message?.content || choice?.text || "";
  }
  if (result.result) return outputText(result.result);
  return "";
}

function decodeBase64(value) {
  const raw = String(value || "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
  if (!raw || raw.length > Math.ceil(MAX_FILE_SIZE * 4 / 3) + 16) {
    throw makeError("Arquivo vazio ou maior que o limite permitido.");
  }
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function checkRateLimit(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const history = requestHistory.get(ip) || [];
  const recent = history.filter(time => now - time < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw makeError("Muitas solicitações. Aguarde um minuto e tente novamente.", 429);
  }
  recent.push(now);
  requestHistory.set(ip, recent);
  if (requestHistory.size > 2000) {
    for (const [key, times] of requestHistory) {
      if (!times.length || now - times[times.length - 1] > RATE_LIMIT_WINDOW) requestHistory.delete(key);
    }
  }
}

function isPublicHttpUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "0.0.0.0" || host === "::1") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  return true;
}

async function readPage(rawUrl) {
  if (!isPublicHttpUrl(rawUrl)) throw makeError("Informe um link público HTTP ou HTTPS válido.");
  let url = new URL(rawUrl);
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch(url.toString(), {
      redirect: "manual",
      headers: { "User-Agent": "FuotIA/1.0 (page reader)", "Accept": "text/html,text/plain,application/xhtml+xml" },
      signal: AbortSignal.timeout(12_000)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location || attempt === 3) throw makeError("O site redirecionou muitas vezes.", 422);
      url = new URL(location, url);
      if (!isPublicHttpUrl(url.toString())) throw makeError("O link redirecionou para um endereço não permitido.", 422);
      continue;
    }
    break;
  }
  if (!response?.ok) throw makeError("Não foi possível abrir esse link (HTTP " + (response?.status || "erro") + ").", 422);
  const type = response.headers.get("content-type") || "";
  if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(type)) throw makeError("Esse link não parece conter uma página de texto.", 415);
  const html = await response.text();
  const plain = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/article|\/section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t\r]+/g, " ").replace(/\n\s+/g, "\n")
    .trim();
  if (!plain) throw makeError("Não encontrei texto legível nessa página.", 422);
  return plain.slice(0, 18_000);
}

async function askAI(env, message, image) {
  if (!env.AI) throw makeError("A conexão Workers AI (binding AI) não está configurada.", 503);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: message || "Analise esta imagem e descreva o que é relevante." },
        { type: "image_url", image_url: { url: image.startsWith("data:") ? image : "data:image/jpeg;base64," + image } }
      ]
    });
    const result = await env.AI.run(VISION, { messages, max_tokens: 900 });
    return outputText(result) || "Não consegui analisar essa imagem.";
  }
  messages.push({ role: "user", content: message });
  const result = await env.AI.run(MODEL, { messages, max_tokens: 1200, temperature: 0.6 });
  return outputText(result) || "Não consegui gerar uma resposta.";
}

async function searchAndAnswer(env, query) {
  if (!env.AI?.websearch) throw makeError("A pesquisa ainda não está disponível neste Worker. Verifique o binding AI e o acesso ao Web Search.", 503);
  const response = await env.AI.websearch({
    gatewayId: "default",
    query,
    provider: "exa",
    limit: 5
  });
  if (!response.ok) throw makeError("A pesquisa na internet falhou. Verifique os créditos ou a configuração do AI Gateway.", 502);
  const data = await response.json();
  const compact = JSON.stringify(data).slice(0, 14_000);
  const text = await askAI(env,
    "Responda à pergunta usando os resultados atuais abaixo. Diferencie fatos de incertezas e não invente fontes. Inclua links quando estiverem presentes nos resultados.\nPergunta: " + query + "\nResultados: " + compact
  );
  return { text, sources: data };
}

async function handleAction(data, env) {
  const action = data.action;
  if (action === "chat") {
    const message = String(data.message || "").trim();
    if (!message && !data.image) throw makeError("Escreva uma mensagem ou envie uma imagem.");
    return { text: await askAI(env, message.slice(0, 16_000), data.image || null) };
  }
  if (action === "search") {
    const query = String(data.query || "").trim();
    if (!query) throw makeError("Digite o que deseja pesquisar.");
    return await searchAndAnswer(env, query.slice(0, 1000));
  }
  if (action === "read_url") {
    const url = String(data.url || "").trim();
    const page = await readPage(url);
    const text = await askAI(env,
      "Resuma e explique o conteúdo abaixo. Use somente as informações da página e avise se algo não estiver claro. URL: " + url + "\n\nCONTEÚDO:\n" + page
    );
    return { text, url };
  }
  if (action === "generate_image") {
    const prompt = String(data.prompt || "").trim();
    if (!prompt) throw makeError("Descreva a imagem que deseja criar.");
    if (!env.AI) throw makeError("A conexão Workers AI não está configurada.", 503);
    const result = await env.AI.run(IMAGE_MODEL, { prompt: prompt.slice(0, 1500), steps: 4 });
    const image = result?.image || result?.result?.image;
    if (!image) throw makeError("O modelo não retornou uma imagem.", 502);
    return { image };
  }
  if (action === "transcribe") {
    if (!data.audio) throw makeError("Nenhum áudio foi enviado.");
    const audio = decodeBase64(data.audio);
    if (!env.AI) throw makeError("A conexão Workers AI não está configurada.", 503);
    const result = await env.AI.run(AUDIO_MODEL, { audio: [...audio] });
    return { text: result?.text || outputText(result) || "" };
  }
  throw makeError("Ação não reconhecida.", 400);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return json({ error: "Método não permitido." }, 405, origin);
    try {
      checkRateLimit(request);
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY_SIZE) throw makeError("Solicitação muito grande.", 413);
      const raw = await request.text();
      if (raw.length > MAX_BODY_SIZE) throw makeError("Solicitação muito grande.", 413);
      let data;
      try { data = JSON.parse(raw); } catch { throw makeError("Formato de solicitação inválido."); }
      if (data.action === "chat" && !data.image) {
        const message = String(data.message || "").trim();
        if (!message) throw makeError("Escreva uma mensagem.");
        const text = await askAI(env, message.slice(0, 16_000), null);
        return json({ text }, 200, origin);
      }

      const result = await handleAction(data, env);
      return json(result, 200, origin);
    } catch (error) {
      const status = Number(error.status) || 500;
      return json({ error: status >= 500 ? (error.message || "Erro interno do servidor.") : error.message }, status, origin);
    }
  }
};
