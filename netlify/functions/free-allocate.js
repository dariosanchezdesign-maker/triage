import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Kept byte-identical in spirit to the STAGES/AXES in index.html's inline
// script. Duplicated on purpose: a Netlify function can't import a static
// HTML file's inline <script>, and this keeps the function a single
// self-contained file rather than adding a bundler.
const STAGES = [
  { key: "discovery",     name: "Discovery and constraints",         brief: "Defining the problem, audience, budget, timeline, technical constraints, and what success looks like." },
  { key: "positioning",   name: "Brand positioning",                 brief: "Deciding what the brand stands for, how it's differentiated, and the tone it takes with its audience." },
  { key: "ia",             name: "Information architecture",          brief: "Structuring content and navigation — what pages exist, how they're organized, what order things are encountered in." },
  { key: "visual",        name: "Visual direction",                  brief: "Establishing the visual language — color, type, imagery style, overall aesthetic territory." },
  { key: "layout",        name: "Layout composition",                brief: "Translating visual direction into specific page compositions and grids." },
  { key: "copy",          name: "Copywriting",                       brief: "Writing the actual words — headlines, body copy, microcopy, voice." },
  { key: "prototyping",   name: "Prototyping and interaction design", brief: "Building interactive flows, transitions, and the feel of using the thing." },
  { key: "testing",       name: "User testing",                      brief: "Getting real people to use the thing and reacting to what happens." },
  { key: "accessibility", name: "Accessibility",                     brief: "Ensuring the design works for people with disabilities, per WCAG and related standards." },
  { key: "technical",     name: "Technical build",                   brief: "Implementing the design as working code and infrastructure." }
];

const AXES = [
  { key: "reversibility",           label: "Reversibility",             desc: "How expensive it is to undo this decision later, once it's been acted on." },
  { key: "subjectivity",            label: "Subjectivity & values",     desc: "Whether the decision encodes a judgment specific to this project's identity that can't be benchmarked against a generic standard." },
  { key: "divergence_convergence",  label: "Divergence vs convergence", desc: "Whether the stage is about generating many options quickly, or committing to one." },
  { key: "verifiability",           label: "Verifiability",             desc: "Whether the output can be checked against an objective standard, or requires a real human's subjective reaction to judge." }
];

// The 10 stages are batched into 3 smaller parallel requests instead of one
// big sequential one — each batch asks Claude to reason about only its own
// stages, which cuts both the output-token budget and the wall-clock time
// per call. Grouped roughly by "phase" so each batch stays thematically
// coherent rather than arbitrary.
const STAGE_BATCHES = [
  ["discovery", "positioning", "ia", "visual"],
  ["layout", "copy", "prototyping"],
  ["testing", "accessibility", "technical"]
];

const AXES_TEXT = AXES.map(a => '- ' + a.key + ' — ' + a.label + ': ' + a.desc).join('\n');

function buildClarifyPrompt(mode){
  const schemaText = '{"needs_clarification": boolean, "clarifying_question": string|null, "stakes_read": string|null}';

  const preamble = 'You are the reasoning engine behind Triage, a tool that decides who should own each stage of a design project before work starts — a human, an AI, a collaboration between the two, or a split where different parts of one stage go to different owners. This is "design by refusal" applied up front: default to naming a real constraint, not to flattering the brief.\n\n'
    + 'Right now you are only deciding two things: whether you have enough to reason about real stakes, and if so, what\'s actually at stake in this specific brief. You are NOT reasoning about individual stages yet — that happens separately.';

  const closerAsk = 'If the brief doesn\'t give you enough to reason about real stakes — who it\'s for, what\'s at risk, what "success" would even mean — don\'t guess. Set "needs_clarification" to true and ask exactly one focused clarifying question in "clarifying_question" (the one question that would most change your reasoning). This is the only clarifying question you get. If the brief already gives you enough to work with, set "needs_clarification" to false and fill "stakes_read" with one or two sentences naming what\'s actually high- or low-stakes about this specific brief, grounded in the real client or audience named in the brief — not boilerplate that would fit any project.\n\n'
    + 'Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:\n' + schemaText;

  const closerAnswer = 'You already asked your one clarifying question earlier in this conversation and the user has just answered it. Do not ask another question under any circumstances. Set "needs_clarification" to false and fill "stakes_read" with one or two sentences naming what\'s actually high- or low-stakes about this specific brief.\n\n'
    + 'Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:\n' + schemaText;

  return preamble + '\n\n' + (mode === 'may_ask' ? closerAsk : closerAnswer);
}

function buildBatchPrompt(stageKeys, stakesRead){
  const subset = STAGES.filter(s => stageKeys.includes(s.key));
  const stagesText = subset.map((s, i) => (i + 1) + '. ' + s.name + ' (key: "' + s.key + '") — ' + s.brief).join('\n');
  const schemaText = '{"stages": [{"key": "<one of the stage keys listed>", "owner": "human"|"ai"|"collaborative"|"split", "summary": "one short sentence", "axes_used": ["<subset of the axis keys below, only the ones that actually drove this call>"], "reasoning": "1-2 tightly written sentences, specific to the brief actually given", "parts": [{"label": "short label for this sub-part", "owner": "human"|"ai", "reasoning": "1 sentence"}]}]}';

  return 'You are the reasoning engine behind Triage, a tool that decides who should own each stage of a design project before work starts — a human, an AI, a collaboration between the two, or a split where different parts of one stage go to different owners. This is "design by refusal" applied up front: default to naming a real constraint, not to flattering the brief or handing everything to one side by convenience.\n\n'
    + 'Here is what\'s already been established as actually at stake in this brief: ' + stakesRead + '\n\n'
    + 'Reason about exactly these stages, using these exact keys, in this order (do not reason about any other stage — other stages are being handled in a separate call):\n' + stagesText + '\n\n'
    + 'Weigh each stage against these four axes, but only name the ones that actually drove your call for that specific stage in "axes_used" — most stages are driven by one or two axes, not all four:\n' + AXES_TEXT + '\n\n'
    + 'Owner values: "human", "ai", "collaborative", "split". Use "collaborative" when the stage is a genuine continuous back-and-forth with no clean seam. Use "split" only when the stage\'s own logic really does produce two differently-owned sub-parts (e.g. user testing: recruiting and reading live reactions is human-favorable, synthesizing patterns across many sessions afterward is something AI genuinely helps with) — list those sub-parts in "parts". Don\'t force a split where the honest answer is one owner. Only include "parts" when owner is "split".\n\n'
    + 'Every reasoning string must be grounded in specifics from the brief you were actually given — name the real client, audience, or stakes where relevant. Keep every string as short as it can be while still being specific — one precise sentence beats three generic ones.\n\n'
    + 'Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:\n' + schemaText;
}

const PER_VISITOR_CAP = Number(process.env.FREE_ALLOCATE_PER_VISITOR_CAP || 5);
const GLOBAL_MONTHLY_CAP = Number(process.env.FREE_ALLOCATE_GLOBAL_MONTHLY_CAP || 500);
const VISITOR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const IP_SALT = process.env.FREE_ALLOCATE_IP_SALT || 'allocator-default-salt-please-set-your-own';
const SERVER_API_KEY = process.env.ANTHROPIC_SERVER_API_KEY;

function hashVisitor(ip){
  return crypto.createHash('sha256').update(String(ip) + IP_SALT).digest('hex');
}

function monthKeyFor(date){
  return 'global:' + date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}

function jsonResponse(body, status){
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function validateMessages(messages){
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 6) return false;
  for (const m of messages){
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return false;
    if (!Array.isArray(m.content) || m.content.length !== 1) return false;
    const block = m.content[0];
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return false;
    if (block.text.length === 0 || block.text.length > 4000) return false;
  }
  return true;
}

// One non-streaming call to Anthropic, parsed to JSON. Each batch call is
// small enough (one system prompt covering 3-4 stages, not all 10) that it
// finishes well within a normal request lifetime — batching several of
// these in parallel via Promise.all is what actually solves the timeout,
// rather than trying to keep one giant call alive longer.
async function callAnthropicJSON(systemPrompt, messages, maxTokens){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': SERVER_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages
    })
  });

  if (!res.ok){
    const errText = await res.text();
    const err = new Error(errText.slice(0, 300));
    err.upstream = true;
    throw err;
  }

  const data = await res.json();
  const textBlock = Array.isArray(data.content) ? data.content.find(b => b && b.type === 'text') : null;
  if (!textBlock || typeof textBlock.text !== 'string'){
    console.log('[free-allocate] unexpected Anthropic response shape: ' + JSON.stringify(data).slice(0, 500));
    const err = new Error('Unexpected response shape from Anthropic.');
    err.upstream = true;
    throw err;
  }
  const raw = textBlock.text.trim();
  const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.log('[free-allocate] JSON.parse failed on model output (stop_reason=' + (data.stop_reason || 'unknown') + ', len=' + jsonStr.length + '): ' + jsonStr.slice(0, 400));
    throw err;
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!SERVER_API_KEY) return jsonResponse({ error: 'SERVER_MISCONFIGURED', message: 'Free tier is not configured right now.' }, 500);

  let body;
  try { body = await req.json(); }
  catch (e) { return jsonResponse({ error: 'BAD_REQUEST', message: 'Malformed JSON body.' }, 400); }

  const { mode, messages } = body || {};
  if (mode !== 'may_ask' && mode !== 'must_answer') return jsonResponse({ error: 'BAD_REQUEST', message: 'Invalid mode.' }, 400);
  if (!validateMessages(messages)) return jsonResponse({ error: 'BAD_REQUEST', message: 'Invalid messages.' }, 400);

  const ip = context.ip || 'unknown';
  const visitorKey = 'visitor:' + hashVisitor(ip);
  const now = Date.now();
  const store = getStore('allocator-free-usage');

  const visitorEntry = await store.getWithMetadata(visitorKey, { type: 'json' }).catch(() => null);
  const uses = Array.isArray(visitorEntry?.data) ? visitorEntry.data.filter(ts => now - ts < VISITOR_WINDOW_MS) : [];
  if (uses.length >= PER_VISITOR_CAP){
    const oldestUse = Math.min(...uses);
    const msUntilReset = VISITOR_WINDOW_MS - (now - oldestUse);
    return jsonResponse({ error: 'VISITOR_CAP_REACHED', daysUntilReset: Math.max(1, Math.ceil(msUntilReset / 86400000)) }, 429);
  }

  const monthKey = monthKeyFor(new Date());
  const globalEntry = await store.getWithMetadata(monthKey, { type: 'json' }).catch(() => null);
  const globalCount = typeof globalEntry?.data === 'number' ? globalEntry.data : 0;
  if (globalCount >= GLOBAL_MONTHLY_CAP){
    return jsonResponse({ error: 'GLOBAL_CAP_REACHED' }, 429);
  }

  // The outer response is still a stream (not a plain buffered
  // jsonResponse) purely to stay in Netlify's streaming-function execution
  // budget rather than the shorter synchronous one — the client always
  // reads it as one accumulated chunk (see callTriage() in index.html), so
  // nothing here is progressively rendered. The real fix for the timeout
  // is the batching below, not this.
  const encoder = new TextEncoder();
  const t0 = Date.now();

  const stream = new ReadableStream({
    async start(controller){
      let finalBody;
      let globalCallCount = 1; // clarify call always happens

      try {
        // Step 1: decide clarification + stakes in one small, fast call —
        // this alone was never the slow part.
        const clarify = await callAnthropicJSON(buildClarifyPrompt(mode), messages, 600);

        if (clarify.needs_clarification){
          finalBody = {
            needs_clarification: true,
            clarifying_question: clarify.clarifying_question,
            stakes_read: null,
            stages: []
          };
        } else {
          // Step 2: reason about the 10 stages via 3 parallel batch calls
          // instead of one call covering all of them — this is what
          // actually keeps total wall-clock time short, since the batches
          // run concurrently and each has a much smaller job.
          const batchResults = await Promise.all(
            STAGE_BATCHES.map(keys => callAnthropicJSON(buildBatchPrompt(keys, clarify.stakes_read), messages, 3500))
          );
          globalCallCount += STAGE_BATCHES.length;

          const allStages = batchResults.flatMap(r => (r && Array.isArray(r.stages)) ? r.stages : []);
          const orderedStages = STAGES
            .map(s => allStages.find(st => st && st.key === s.key))
            .filter(Boolean);

          finalBody = {
            needs_clarification: false,
            clarifying_question: null,
            stakes_read: clarify.stakes_read,
            stages: orderedStages
          };
        }

        console.log('[free-allocate] completed in ' + (Date.now() - t0) + 'ms, batches=' + (finalBody.stages.length ? STAGE_BATCHES.length : 0) + ', stageCount=' + finalBody.stages.length);
      } catch (err) {
        console.log('[free-allocate] failed after ' + (Date.now() - t0) + 'ms: ' + String(err && err.message || err));
        finalBody = null;
      }

      // Global cap tracks every successful round of upstream calls (the
      // true cost bound); best-effort compare-and-swap — not perfectly
      // atomic, acceptable given the small dollar amounts involved.
      await store.setJSON(monthKey, globalCount + globalCallCount, globalEntry?.etag ? { onlyIfMatch: globalEntry.etag } : { onlyIfNew: true }).catch(() => {});

      // Visitor cap tracks only completed breakdowns — a clarifying-question
      // round trip doesn't spend a visitor's monthly allowance.
      let visitorRemaining = PER_VISITOR_CAP - uses.length;
      if (finalBody && Array.isArray(finalBody.stages) && finalBody.stages.length > 0){
        const newUses = uses.concat([now]);
        await store.setJSON(visitorKey, newUses, visitorEntry?.etag ? { onlyIfMatch: visitorEntry.etag } : { onlyIfNew: true }).catch(() => {});
        visitorRemaining = PER_VISITOR_CAP - newUses.length;
      }

      const payload = finalBody || { error: 'UPSTREAM_ERROR', message: 'Something went wrong calling Triage.' };
      controller.enqueue(encoder.encode(JSON.stringify(payload)));
      controller.enqueue(encoder.encode('\n<<<FREE_REMAINING:' + Math.max(0, visitorRemaining) + '>>>'));
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

export const config = { path: '/api/free-allocate' };
