// AI writing assistant for certificate wording, powered by Claude.
// Needs ANTHROPIC_API_KEY (or another credential the Anthropic SDK understands) in the environment.
const sdk = require('@anthropic-ai/sdk');

const Anthropic = sdk.default || sdk;
const MODEL = process.env.CERTIFY_AI_MODEL || 'claude-opus-5-5';
let client = null;

function enabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const RULES = `You write wording for printed certificates (awards, course completions, participation, appreciation and similar).
The certificate layout is fixed: TITLE, then a short SUBTITLE line, then the recipient's name in large type, then the BODY text.
- The subtitle is a lead-in that reads naturally right before a person's name, e.g. "This certificate is proudly presented to".
- The body continues straight after the name, so it usually starts in lowercase, e.g. "for successfully completing ...". Keep it to one or two sentences, at most about 40 words.
- Titles are short: at most six words, in Title Case.
- Text inside double braces such as {{course}} or {{date}} is a placeholder filled in per recipient. Keep every existing placeholder exactly as written, never translate or rename it, and never replace it with an invented value.
- When recipient-specific details are needed (a course, a date, a position), use a placeholder in lowercase snake_case, like {{event_name}}, rather than inventing specifics.
- Never write the recipient's name in the subtitle or body; the name is printed separately.
- Match the spelling convention (British or American) already used in the text; default to British spelling.
- Plain text only: no markdown, no quotation marks around the output, no emoji.`;

const wordingSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'subtitle', 'body'],
  additionalProperties: false,
};

async function ask(task, schema) {
  if (!enabled()) throw new AiError('The AI assistant is not set up. Add an ANTHROPIC_API_KEY to the server environment and restart.', 503);
  client ||= new Anthropic();
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: RULES,
      messages: [{ role: 'user', content: task }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('The AI key was rejected. Check ANTHROPIC_API_KEY.', 503);
    if (e instanceof Anthropic.RateLimitError) throw new AiError('The AI assistant is busy right now. Please try again in a minute.', 429);
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('Could not reach the AI service. Check the internet connection.', 503);
    if (e instanceof Anthropic.APIError) throw new AiError(`The AI request failed (${e.status ?? 'error'}). Please try again.`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new AiError('The AI assistant declined this request. Try rephrasing the details.', 422);
  if (response.stop_reason === 'max_tokens') throw new AiError('The AI response was cut short. Please try again.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('The AI returned an unexpected answer. Please try again.');
  }
}

const clip = (s, n = 600) => String(s ?? '').slice(0, n);
const current = (w) => `Current wording:\nTitle: ${clip(w.title, 200)}\nSubtitle: ${clip(w.subtitle, 300)}\nBody: ${clip(w.body)}`;

async function suggest({ purpose, details, tone, orgName, wording }) {
  const task = `Write three different wording options for a certificate.
Purpose: ${clip(purpose, 200) || 'general recognition'}
Tone: ${clip(tone, 60) || 'formal'}
Issuing organisation: ${clip(orgName, 200) || 'not specified'}
Extra details from the user: ${clip(details) || 'none'}
${wording ? current(wording) + '\nKeep any placeholders it uses where they still fit.' : ''}
Make the three options clearly different from each other in phrasing.`;
  const result = await ask(task, {
    type: 'object',
    properties: { options: { type: 'array', items: wordingSchema } },
    required: ['options'],
    additionalProperties: false,
  });
  return { options: (result.options || []).slice(0, 3) };
}

async function check(wording) {
  const task = `Proofread this certificate wording for spelling, grammar, punctuation, capitalisation and awkward phrasing.
${current(wording)}
Report each real problem as an issue (field is "title", "subtitle" or "body"; "original" is the exact problematic snippet; "suggestion" is the replacement snippet; "explanation" is one short sentence for a non-expert).
Do not report placeholders in double braces as errors, and do not report pure style preferences.
Also return the fully corrected wording with only those fixes applied. If nothing is wrong, return an empty issues list and the wording unchanged.`;
  const result = await ask(task, {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: ['title', 'subtitle', 'body'] },
            original: { type: 'string' },
            suggestion: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['field', 'original', 'suggestion', 'explanation'],
          additionalProperties: false,
        },
      },
      corrected: wordingSchema,
    },
    required: ['issues', 'corrected'],
    additionalProperties: false,
  });
  return result;
}

async function rewrite(wording, instruction) {
  const task = `Rewrite this certificate wording. Instruction: ${clip(instruction, 300)}
${current(wording)}
Keep the meaning and every placeholder.`;
  return ask(task, wordingSchema);
}

module.exports = { enabled, suggest, check, rewrite, AiError, MODEL };
