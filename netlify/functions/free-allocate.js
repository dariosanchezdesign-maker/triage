import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

// Kept byte-identical in spirit to the STAGES/AXES/buildSystemPrompt in
// index.html's inline script. Duplicated on purpose: a Netlify function
// can't import a static HTML file's inline <script>, and this keeps the
// function a single self-contained file rather than adding a bundler.
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

function buildSystemPrompt(mode){
  const stagesText = STAGES.map((s,i) => (i+1) + '. ' + s.name + ' (key: "' + s.key + '") — ' + s.brief).join('\n');
  const axesText = AXES.map(a => '- ' + a.key + ' — ' + a.label + ': ' + a.desc).join('\n');
  const schemaText = '{"needs_clarification": boolean, "clarifying_question": string|null, "stakes_read": string|null, "stages": [{"key": "<one of the stage keys above>", "owner": "human"|"ai"|"collaborative"|"split", "summary": "one short sentence", "axes_used": ["<subset of the axis keys above, only the ones that actually drove this call>"], "reasoning": "2-4 sentences, specific to the brief actually given", "parts": [{"label": "short label for this sub-part", "owner": "human"|"ai", "reasoning": "1-2 sentences"}]}]}';

  const preamble = 'You are the reasoning engine behind Allocator, a tool that decides who should own each stage of a design project before work starts — a human, an AI, a collaboration between the two, or a split where different parts of one stage go to different owners. This is "design by refusal" applied up front: default to naming a real constraint, not to flattering the brief or handing everything to one side by convenience.\n\n'
    + 'Reason about all ten fixed stages, always in this exact order and using these exact keys:\n' + stagesText + '\n\n'
    + 'Weigh each stage against these four axes, but only name the ones that actually drove your call for that specific stage in "axes_used" — most stages are driven by one or two axes, not all four:\n' + axesText + '\n\n'
    + 'Owner values: "human", "ai", "collaborative", "split". Use "collaborative" when the stage is a genuine continuous back-and-forth with no clean seam. Use "split" only when the stage\'s own logic really does produce two differently-owned sub-parts (e.g. user testing: recruiting and reading live reactions is human-favorable, synthesizing patterns across many sessions afterward is something AI genuinely helps with) — list those sub-parts in "parts". Don\'t force a split where the honest answer is one owner, and don\'t collapse a genuine split into one label for tidiness. Only include "parts" when owner is "split".\n\n'
    + 'Every reasoning string must be grounded in specifics from the brief you were actually given — name the real client, audience, or stakes where relevant. If a sentence you\'re about to write would be equally true of a completely different, unrelated project, rewrite it until it wouldn\'t be. The same stage should get different weight and reasoning depending on what\'s actually at stake in this brief — a low-stakes hobby project and a high-stakes commercial one should not read as boilerplate.';

  const closerAsk = 'If the brief doesn\'t give you enough to reason about real stakes — who it\'s for, what\'s at risk, what "success" would even mean — don\'t guess. Set "needs_clarification" to true, ask exactly one focused clarifying question in "clarifying_question" (the one question that would most change your reasoning), and leave "stages" as an empty array. This is the only clarifying question you get. If the brief already gives you enough to work with, skip straight to the full breakdown with "needs_clarification": false and "stakes_read" filled in with one or two sentences naming what\'s actually high- or low-stakes about this specific brief.\n\n'
    + 'Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:\n' + schemaText;

  const closerAnswer = 'You already asked your one clarifying question earlier in this conversation and the user has just answered it. Do not ask another question under any circumstances. Set "needs_clarification" to false, fill in "stakes_read", and produce the full ten-stage breakdown now, stating any remaining assumptions briefly inside the relevant stage\'s own reasoning rather than asking further.\n\n'
    + 'Respond with ONLY valid JSON, no markdown fences, no commentary outside the JSON, matching exactly this shape:\n' + schemaText;

  return preamble + '\n\n' + (mode === 'may_ask' ? closerAsk : closerAnswer);
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

  // The full ten-stage breakdown can take longer to generate than
  // Netlify's synchronous function timeout allows (10s default, 26s max
  // even on paid plans). Streaming the response back keeps the connection
  // actively sending bytes, which sidesteps that limit — a buffered
  // await-then-return response does not. We ask Anthropic to stream too,
  // reassemble the text deltas server-side (to run cap bookkeeping once
  // the full JSON is known), while forwarding each delta to the client as
  // it arrives.
  let upstreamRes;
  try {
    upstreamRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': SERVER_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system: [{ type: 'text', text: buildSystemPrompt(mode), cache_control: { type: 'ephemeral' } }],
        messages,
        stream: true
      })
    });
  } catch (err) {
    return jsonResponse({ error: 'UPSTREAM_ERROR', message: String(err && err.message || err).slice(0, 200) }, 502);
  }

  if (!upstreamRes.ok){
    const errText = await upstreamRes.text();
    return jsonResponse({ error: 'UPSTREAM_ERROR', message: errText.slice(0, 300) }, 502);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller){
      const reader = upstreamRes.body.getReader();
      let fullText = '';
      let sseBuffer = '';
      try {
        while (true){
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop();
          for (const line of lines){
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6).trim();
            if (!dataStr) continue;
            let evt;
            try { evt = JSON.parse(dataStr); } catch (e) { continue; }
            if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta'){
              fullText += evt.delta.text;
              controller.enqueue(encoder.encode(evt.delta.text));
            }
          }
        }
      } catch (err) {
        // Upstream stream broke mid-flight — fall through with whatever
        // text was accumulated; the JSON.parse below will fail cleanly
        // and the client shows its generic error rather than hanging.
      }

      let parsed = null;
      try {
        const jsonStr = fullText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
        parsed = JSON.parse(jsonStr);
      } catch (err) { /* leave parsed null */ }

      // Global cap tracks every successful upstream call (the true cost
      // bound); best-effort compare-and-swap — not perfectly atomic,
      // acceptable given the small dollar amounts involved.
      await store.setJSON(monthKey, globalCount + 1, globalEntry?.etag ? { onlyIfMatch: globalEntry.etag } : { onlyIfNew: true }).catch(() => {});

      // Visitor cap tracks only completed breakdowns — a clarifying-question
      // round trip doesn't spend a visitor's monthly allowance.
      let visitorRemaining = PER_VISITOR_CAP - uses.length;
      if (parsed && Array.isArray(parsed.stages) && parsed.stages.length > 0){
        const newUses = uses.concat([now]);
        await store.setJSON(visitorKey, newUses, visitorEntry?.etag ? { onlyIfMatch: visitorEntry.etag } : { onlyIfNew: true }).catch(() => {});
        visitorRemaining = PER_VISITOR_CAP - newUses.length;
      }

      // Sentinel trailer, not part of the JSON body: tells the client how
      // many free uses remain without needing a second round trip.
      controller.enqueue(encoder.encode('\n<<<FREE_REMAINING:' + Math.max(0, visitorRemaining) + '>>>'));
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

export const config = { path: '/api/free-allocate' };
