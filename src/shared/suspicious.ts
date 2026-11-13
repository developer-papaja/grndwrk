/**
 * Signs that a comment from the running product reads like orders to an AI
 * agent rather than a report about the product: it asks to ignore rules,
 * speaks to the agent, holds a command or code, asks for secrets, names the
 * agent's own files, links to a script, or hides text. Written on the
 * comment as `suspicious:`, shown in the map, and the agent's rules say to
 * act on none of it and tell the person.
 *
 * A warning, never a filter: the comment is kept as it was sent. Kept
 * cautious, so an ordinary comment ("The password field is too small")
 * is not marked.
 */
// Words for "ignore" and for "instructions" in the languages comments are most
// often written in here (English, Swedish, Norwegian, Danish, German, Dutch,
// French, Spanish), so a comment in another language is caught too.
const IGNORE = String.raw`ignore|ignorera|ignorer|ignoriere|ignorieren|negeer|ignora|disregard|forget|override|bypass|glöm|glem|strunta\s+i|bortse\s+från|se\s+bort\s+från|skippa|vergiss|vergeet|oublie|olvida|no\s+hagas\s+caso`
const RULES = String.raw`instructions?|prompts?|rules?|guidelines?|guardrails?|context|instruktion(?:er|erna|en)?|instruksjon(?:er|ene)?|regl(?:er|erna)|regl(?:ene)?|anvisning(?:ar|arna)?|riktlinjer|Anweisung(?:en)?|Regeln|instructies|regels|consignes|règles|instrucciones|reglas`
const AGENT_FILES = String.raw`agents?\.md|claude\.md|gemini\.md|skill\.md|\.cursorrules|copilot-instructions|\.claude\/|\.agents\/|\.grndwrk\/`
/** "run the command", "kör kommandot", "führe den Befehl aus", or run followed by a slash command. */
const RUN = String.raw`run|execute|exec|kör|köra|exekvera|kjør|udfør|führe|ausführen|voer\s+uit|exécute|lance|ejecuta|corre`
const COMMAND = String.raw`commands?|kommando(?:t|n|er|na)?|kommandoen|Befehl|commando|commande|comando`

/** Commands agents run by name: grndwrk's own, and common ones built into agents. A page's path (/visits) is not one. */
const SLASH = String.raw`feedback|readiness|brief|survey|sitemap|decisions|topics|challenge|import|questions|personas|review|init|clear|compact|config|permissions|hooks|agents|mcp|model|login|logout|install|deploy|security-review|code-review|bash|shell|run|exec`

const SIGNS: [RegExp, string][] = [
  [new RegExp(String.raw`(?:${IGNORE})\b[^\n]{0,60}?(?:\b(?:${RULES})\b|${AGENT_FILES})`, 'i'), 'asks to ignore instructions'],
  [/\b(as an? (ai|assistant|language model|llm)|dear (claude|ai|assistant|agent|codex)|(hey|hi|hello|hej|hallå) (claude|chatgpt|codex|cursor|copilot|agent|assistant)\b|(claude|chatgpt|codex|cursor|copilot|the agent|the assistant|ai agent|the ai|llm)[,:]?\s+(please\s+)?(must|should|run|execute|delete|remove|change|edit|write|open|read|install|commit|push|add|fetch|send|ignore)\b|you are (now )?(an? )?(ai|assistant|agent|claude|developer mode)\b|from now on,? you\b|system prompt|\b(din|er|your|deine?|jullie|votre|ton|tu)\s+(ai-?)?(agent|agenten|assistent|assistant|ai)\b)/i, 'speaks to the AI agent'],
  [/<\/?(system|assistant|user|instructions?|tool_call|function_calls?)>|\[\/?INST\]|<\|im_(start|end)\|>|^\s*#{1,6}\s*(system|instructions?|new task)\b|^\s*\*\*(claude|you)( asks)?\*\*\s*·/im, 'imitates a prompt or a thread entry'],
  [new RegExp(String.raw`\b(?:${RUN})\b[^\n.]{0,40}?(?:\b(?:${COMMAND})\b|(?:^|\s)\/(?:${SLASH})(?:\s|$|[.,!?]))`, 'i'), 'asks to run a command'],
  [/(^|[\s`'"(;|&])(sudo\s|rm\s+-[a-z]*[rf]|curl\s+\S|wget\s+\S|chmod\s+[0-7+]|chown\s|bash\s+-c|sh\s+-c|zsh\s+-c|powershell\b|iex\s*\(|invoke-(webrequest|expression)|npm\s+(i|install|run|exec)\b|npx\s+\S|pnpm\s+(add|dlx)\b|yarn\s+(add|dlx)\b|pip3?\s+install|brew\s+install|git\s+(push|reset|commit|clone|config|checkout)\b|eval\s*\(|exec\s*\(|base64\s+(-d|--decode)|\|\s*(ba|z)?sh\b|>\s*\/dev\/|nc\s+-[a-z]*e)/im, 'holds a command to run'],
  [/```|<script\b|<iframe\b|javascript:|on(error|load|click)\s*=|<\?php|\bimport\s+os\b|require\(['"]child_process/i, 'holds code'],
  [/\b(send|print|post|reveal|upload|share|email|exfiltrate|output|leak|dump|cat|skicka|skriv ut|dela|ladda upp|schicke|sende|envoie|envía|stuur)\b[^\n]{0,40}?(?:\b(api[_ -]?keys?|api-?nycklar(na)?|access tokens?|secret keys?|secrets|passwords|lösenord(en)?|hemligheter(na)?|ssh keys?|ssh-nycklar(na)?|credentials|private keys?|keychain|lan-code|lan-devices|team key|owner key|Passwörter|mots de passe|contraseñas)\b|\.env\b)/i, 'asks for secrets'],
  [new RegExp(String.raw`(~\/\.ssh|\/etc\/(passwd|shadow)|\.git\/(config|hooks)|\.env\b|(?:^|[\s"'\x60(/])(?:${AGENT_FILES}))`, 'i'), 'names the agent’s or the project’s own files'],
  [/https?:\/\/\S+\.(sh|ps1|bat|cmd|exe|py|pl|rb|js|mjs)(?![\w-])|\b(raw\.githubusercontent\.com|pastebin\.com|gist\.githubusercontent\.com|transfer\.sh|ngrok\.(io|app))\b/i, 'links to a script or a file to download'],
  [/[A-Za-z0-9+/]{120,}={0,2}|(?:\\x[0-9a-f]{2}){8,}|(?:%[0-9a-f]{2}){16,}/i, 'holds a long encoded string'],
  [/[\u200b-\u200d\u2060\u2062-\u2064\ufeff\u00ad]|[\u{e0000}-\u{e007f}]/u, 'holds invisible characters'],
]

/** Why a comment reads like orders to an agent, in plain words; empty when it does not. */
export function suspiciousSigns(...texts: (string | undefined)[]): string[] {
  const text = texts.filter(Boolean).join('\n')
  if (!text) return []
  return SIGNS.filter(([re]) => re.test(text)).map(([, why]) => why)
}
