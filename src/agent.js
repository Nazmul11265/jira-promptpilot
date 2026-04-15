/**
 * ReAct Agent Loop
 * ────────────────
 * Uses Groq (Llama) with tool calling to run a THINK → ACT → OBSERVE → REFLECT
 * cycle until the agent decides it has enough information to generate a
 * VS Code Copilot prompt for the given Jira ticket.
 */

import Groq from 'groq-sdk';
import { fetchJiraTicket } from './tools/jira.js';
import { searchWorkspace, readWorkspaceFile } from './tools/workspace.js';
import { generateCopilotPrompt } from './tools/prompt.js';
import { loadTicketMemory, saveTicketMemory } from './memory.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── PromptPilot infrastructure files (not target-application code) ───────────
// Used to detect when the agent is about to cite its own source files as fixes.
const PROMPTPILOT_OWN_FILES = new Set([
  'src/agent.js',
  'src/index.js',
  'src/memory.js',
  'src/tools/jira.js',
  'src/tools/prompt.js',
  'src/tools/workspace.js',
  'test-agent.js',
  'package.json',
  'README.md',
]);

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are PromptPilot, an expert software engineering agent embedded in VS Code.

Your mission: given a Jira ticket ID, analyze the ticket and the codebase, identify the root cause, then produce an optimal VS Code Copilot prompt that will guide the AI to fix the issue correctly.

## Strict ReAct Protocol

Before EVERY tool call, write your internal monologue using these labels:

  THINK: <what you know, what you need, and why you chose this tool>

After EVERY tool result, write:

  OBSERVE: <concise summary of what the result tells you>
  REFLECT: <have you found what you need? what is your next step?>

## CRITICAL — read carefully

1. NEVER write "ACT: search_workspace" or any tool name as plain text.
   ACT means invoking the actual function via the tool-calling API.
   Writing a tool name as prose does NOT execute anything.
2. You MUST keep calling tool functions until you call generate_prompt.
   Do NOT stop mid-investigation. Do NOT return a partial response.
3. If you are about to type "ACT:" as text, STOP and call the real function instead.
4. NEVER use XML-style or angle-bracket-style function calls such as
   <function=tool_name {"arg":"value"}></function>  — this format is INVALID.
   Tool calls MUST be made exclusively through the API's structured tool_calls mechanism.
   Any text that looks like <function=...> in your output will cause a hard API error.

## Workflow (follow this order)

1. search_workspace   → find files related to the problem keywords
2. read_file          → read the 1-2 most relevant files to confirm root cause
3. generate_prompt    → ONLY when confident — this produces the final answer

## Rules

- Skip files that are clearly unrelated.
- Be efficient: 4-6 tool calls is ideal; 10 is the hard limit.
- Use precise keywords from the ticket description when searching.
- If search finds nothing, try a different or broader keyword.
- Fill every generate_prompt field with concrete details from files you read.
- Do NOT invent code; only report what you actually observed.

## Evidence Quality — MANDATORY

- NEVER invent root causes or code snippets you did not observe in actual file reads.
- The following are PromptPilot infrastructure files — do NOT list them in relevant_files unless the ticket is specifically about PromptPilot itself: src/agent.js, src/index.js, src/memory.js, src/tools/jira.js, src/tools/prompt.js, src/tools/workspace.js, test-agent.js, package.json.
- If search_workspace returns only PromptPilot infrastructure files (the files above), it means the target application code is NOT present in the workspace. In that case you MUST set root_cause to "UNVERIFIED — application source files not found in this workspace" and fix_approach to "Point the workspace root at the target application repository and re-run PromptPilot."
- Only call generate_prompt after reading at least one non-infrastructure file that contains code related to the problem. If you cannot find such a file after two searches, call generate_prompt immediately with the UNVERIFIED root cause above.`;

// ─── Tool Schema (Groq function-calling format) ───────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'fetch_jira_ticket',
      description:
        'Fetch the full details of a Jira ticket: title, type, priority, description, and recent comments.',
      parameters: {
        type: 'object',
        properties: {
          ticket_id: {
            type: 'string',
            description: 'Jira ticket ID, e.g. PROJ-123',
          },
        },
        required: ['ticket_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_workspace',
      description:
        'Full-text search across workspace files. Returns matching file paths and the lines that matched.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search keywords — component names, function names, error messages, etc.',
          },
          file_pattern: {
            type: 'string',
            description:
              'Optional glob to narrow the search, e.g. "**/*.jsx" or "src/**/*.ts".',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a specific workspace file.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path relative to the workspace root.',
          },
          start_line: {
            type: 'number',
            description: 'First line to read (1-based, inclusive). Omit to read from the top.',
          },
          end_line: {
            type: 'number',
            description: 'Last line to read (1-based, inclusive). Omit to read to the end.',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_prompt',
      description:
        'FINAL STEP. Call this once you have identified the root cause. ' +
        'Generates a structured VS Code Copilot prompt for the fix.',
      parameters: {
        type: 'object',
        properties: {
          ticket_summary: {
            type: 'string',
            description: 'One-sentence summary of the Jira ticket.',
          },
          issue_type: {
            type: 'string',
            description: 'Bug | Feature | Task | Improvement',
          },
          root_cause: {
            type: 'string',
            description:
              'Precise technical description of the root cause discovered in the code.',
          },
          relevant_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative paths of files that need to change.',
          },
          code_context: {
            type: 'string',
            description:
              'Key code snippet(s) showing the problem (actual code from the files, not invented).',
          },
          fix_approach: {
            type: 'string',
            description: 'Step-by-step description of the recommended fix.',
          },
          acceptance_criteria: {
            type: 'string',
            description: 'What must be true after the fix is applied.',
          },
        },
        required: [
          'ticket_summary',
          'root_cause',
          'fix_approach',
        ],
      },
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

async function executeTool(name, args, workspaceRoot) {
  switch (name) {
    case 'fetch_jira_ticket':
      return fetchJiraTicket(args.ticket_id);

    case 'search_workspace':
      return searchWorkspace(args.query, args.file_pattern, workspaceRoot);

    case 'read_file':
      return readWorkspaceFile(
        args.file_path,
        workspaceRoot,
        args.start_line,
        args.end_line
      );

    case 'generate_prompt':
      return generateCopilotPrompt(args);

    default:
      throw new Error(`Unknown internal tool: ${name}`);
  }
}

// ─── Plan Builder ─────────────────────────────────────────────────────────────

const PLAN_SYSTEM =
  'You are a planning agent. Given a Jira ticket, output a JSON investigation plan. ' +
  'Output ONLY valid JSON — no markdown, no explanation, just the JSON object.';

async function buildPlan(ticketId, ticketData, priorMemory) {
  const ticketDesc = ticketData
    ? `Ticket "${ticketId}": "${ticketData.title}" (${ticketData.type}, ${ticketData.priority}).\nDescription: ${ticketData.description?.slice(0, 600) ?? 'N/A'}`
    : `Ticket "${ticketId}" (content not yet fetched).`;

  const memoryNote = priorMemory
    ? `\nThis ticket was previously investigated. Prior root cause: "${priorMemory.rootCause}". Files read: ${priorMemory.filesRead?.join(', ')}.`
    : '';

  try {
    const r = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: PLAN_SYSTEM },
        {
          role: 'user',
          content:
            `${ticketDesc}${memoryNote}\n\n` +
            'Produce a JSON plan with exactly these keys:\n' +
            '- goal (string)\n' +
            '- steps (string[])\n' +
            '- expected_tools (string[])\n' +
            '- key_unknowns (string[])',
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });
    return JSON.parse(r.choices[0].message.content);
  } catch (err) {
    console.error(`[Plan] Failed (${err.message}) — using default plan.`);
    return {
      goal: `Investigate root cause of Jira ticket ${ticketId}`,
      steps: [
        'Fetch the full ticket details',
        'Search workspace for relevant files',
        'Read the most relevant file(s)',
        'Generate a Copilot fix prompt',
      ],
      expected_tools: ['fetch_jira_ticket', 'search_workspace', 'read_file', 'generate_prompt'],
      key_unknowns: ['What component is affected?', 'What is the root cause?'],
    };
  }
}

// ─── ReAct Section Parser ─────────────────────────────────────────────────────

function parseReActSections(text) {
  if (!text) return {};
  const extract = (label) =>
    text.match(
      new RegExp(`${label}:\\s*([\\s\\S]+?)(?=\\s*(?:THINK:|ACT:|OBSERVE:|REFLECT:)\\s|$)`, 'i')
    )?.[1]?.trim() ?? null;
  return {
    think:   extract('THINK'),
    observe: extract('OBSERVE'),
    reflect: extract('REFLECT'),
  };
}

function logReActSections({ think, observe, reflect }, hasToolCalls, iteration) {
  const p = `[i${iteration}]`;
  if (think)   console.error(`${p} THINK   → ${think.slice(0, 250)}`);
  if (observe) console.error(`${p} OBSERVE → ${observe.slice(0, 250)}`);
  if (reflect) console.error(`${p} REFLECT → ${reflect.slice(0, 250)}`);
  if (hasToolCalls && !think) {
    console.error(`${p} ⚠ No THINK section before tool call — shallow reasoning`);
    return true; // signal: inject a corrective nudge
  }
  return false;
}

// ─── Text-format tool call parser ──────────────────────────────────────────────
// Fallback for when the model emits a tool call as JSON text instead of using
// the API's structured tool_calls mechanism.
// Handles patterns like: {"type":"function","name":"foo","parameters":{...}}
function parseTextToolCalls(content) {
  if (!content) return [];
  const knownNames = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));
  const results = [];

  // Walk the string looking for '{' and try to extract balanced JSON objects.
  let i = 0;
  while (i < content.length) {
    const start = content.indexOf('{', i);
    if (start === -1) break;

    let depth = 0;
    let j = start;
    let inString = false;
    let escape = false;

    while (j < content.length) {
      const ch = content[j];
      if (escape) { escape = false; j++; continue; }
      if (ch === '\\' && inString) { escape = true; j++; continue; }
      if (ch === '"') { inString = !inString; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
      }
      j++;
    }

    if (depth === 0) {
      const candidate = content.slice(start, j + 1);
      try {
        const obj = JSON.parse(candidate);
        // Support multiple text-call shapes:
        //   {"name":"foo","parameters":{...}}
        //   {"type":"function","name":"foo","parameters":{...}}
        //   {"function":{"name":"foo","arguments":{...}}}
        const name =
          obj.name ??
          obj.function?.name;
        let args =
          obj.parameters ??
          obj.arguments ??
          obj.function?.parameters ??
          obj.function?.arguments ??
          {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        if (name && knownNames.has(name)) {
          results.push({ name, args });
        }
      } catch {
        // not valid JSON — skip
      }
      i = j + 1;
    } else {
      i = start + 1;
    }
  }

  return results;
}

// Parses Groq's XML-ish tool call text from `failed_generation`.
// Accepts both well-formed and malformed variants, for example:
//   <function=search_workspace {"query":"..."}></function>
//   <function=search_workspace {"query":"..."}> THINK: ...
function parseXmlToolCall(text) {
  if (!text) return null;
  const knownNames = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

  const fnMatch = text.match(/<function=(\w+)\b/);
  if (!fnMatch) return null;

  const name = fnMatch[1];
  if (!knownNames.has(name)) return null;

  const jsonStart = text.indexOf('{', fnMatch.index);
  if (jsonStart === -1) return null;

  // Extract first balanced JSON object after <function=...>
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  try {
    const args = JSON.parse(text.slice(jsonStart, end + 1));
    return { name, args };
  } catch {
    return null;
  }
}

// ─── ReAct Loop ───────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

export async function runAgent(ticketId, workspaceRoot) {
  console.error(`\n${'═'.repeat(60)}`);
  console.error(`[PromptPilot] Ticket    : ${ticketId}`);
  console.error(`[PromptPilot] Workspace : ${workspaceRoot}`);
  console.error(`[PromptPilot] Model     : ${process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant'}`);
  console.error(`${'═'.repeat(60)}`);

  // ── Phase 1: Cross-run memory ─────────────────────────────────────────────
  const priorMemory = loadTicketMemory(ticketId, workspaceRoot);
  if (priorMemory) {
    console.error(`[Memory] Prior investigation found (last: ${priorMemory.lastUpdated})`);
  }

  // ── Phase 2: Pre-fetch ticket to inform planning ──────────────────────────
  let ticketData = null;
  try {
    ticketData = await fetchJiraTicket(ticketId);
    console.error(`[Prefetch] "${ticketData.title}" (${ticketData.type}, ${ticketData.priority})`);
  } catch (err) {
    console.error(`[Prefetch] Failed: ${err.message} — model will call fetch_jira_ticket`);
  }

  // ── Phase 3: Build structured investigation plan ──────────────────────────
  const plan = await buildPlan(ticketId, ticketData, priorMemory);
  console.error(`\n[PLAN] Goal: ${plan.goal}`);
  plan.steps.forEach((s, i) => console.error(`  ${i + 1}. ${s}`));
  if (plan.key_unknowns?.length) {
    console.error(`[PLAN] Unknowns: ${plan.key_unknowns.join(' | ')}`);
  }

  // ── Phase 4: Build context-rich initial message ───────────────────────────
  const ticketSection = ticketData
    ? 'TICKET (already fetched — do NOT call fetch_jira_ticket again):\n' +
      `  Title     : ${ticketData.title}\n` +
      `  Type      : ${ticketData.type}  |  Priority: ${ticketData.priority}  |  Status: ${ticketData.status}\n` +
      `  Labels    : ${ticketData.labels?.join(', ') || 'none'}\n` +
      `  Components: ${ticketData.components?.join(', ') || 'none'}\n` +
      `  Description:\n${ticketData.description?.slice(0, 1000) ?? 'N/A'}`
    : `Start by calling fetch_jira_ticket("${ticketId}").`;

  const memorySection = priorMemory
    ? '\n\nPRIOR INVESTIGATION (cross-run memory — verify or update before generating prompt):\n' +
      `  Summary    : ${priorMemory.ticketSummary}\n` +
      `  Files read : ${priorMemory.filesRead?.join(', ') || 'none'}\n` +
      `  Root cause : ${priorMemory.rootCause}\n` +
      `  Last run   : ${priorMemory.lastUpdated}`
    : '';

  const planSection =
    '\n\nINVESTIGATION PLAN:\n' +
    `  Goal: ${plan.goal}\n` +
    plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
    `\n  Key unknowns: ${plan.key_unknowns?.join('; ') || 'none'}`;

  const messages = [
    {
      role: 'user',
      content:
        `Analyze Jira ticket "${ticketId}" and call generate_prompt when done.\n\n` +
        `${ticketSection}${memorySection}${planSection}\n\n` +
        'Begin. Output THINK, OBSERVE, REFLECT for each step.',
    },
  ];

  // ── Phase 5: Memory tracking for this run ────────────────────────────────
  const memoryData = {
    ticketSummary: ticketData?.title ?? ticketId,
    filesRead:     [],
    searchQueries: [],
    rootCause:     null,
    fixApproach:   null,
    relevantFiles: [],
  };

  // ── Phase 6: ReAct loop ───────────────────────────────────────────────────
  let finalPrompt = null;
  let iteration = 0;
  let xmlFormatRetries = 0;

  while (iteration < MAX_ITERATIONS && finalPrompt === null) {
    iteration++;
    console.error(`\n[Loop] ── Iteration ${iteration} ──────────────────────`);

    let response;
    try {
      response = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL ?? 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        tools: TOOL_DEFINITIONS,
        tool_choice: 'required',
        temperature: 0.1,
      });
    } catch (apiErr) {
      // Groq raises a 400 tool_use_failed when the model writes
      // <function=name {args}> XML-style calls instead of using tool_calls.
      const isToolUseFailed =
        apiErr?.status === 400 &&
        (apiErr?.error?.code === 'tool_use_failed' ||
          String(apiErr?.message ?? '').includes('tool call validation failed'));

      if (!isToolUseFailed) throw apiErr;

      xmlFormatRetries++;

      // ── Try to extract + execute the call from failed_generation ───────
      // Groq embeds the model's raw output in the error body.
      const failedGen =
        apiErr.error?.failed_generation ??
        (() => {
          try {
            const body = JSON.parse(
              String(apiErr.message ?? '').replace(/^[^{]*/, '')
            );
            return body?.error?.failed_generation ?? null;
          } catch { return null; }
        })();

      const recovered = parseXmlToolCall(failedGen);

      if (recovered) {
        console.error(
          `[Loop] ⚠ XML tool call recovered from error (attempt ${xmlFormatRetries}) — executing "${recovered.name}".`
        );

        let result;
        try {
          result = await executeTool(recovered.name, recovered.args, workspaceRoot);
        } catch (toolErr) {
          result = { error: toolErr.message };
          console.error(`[Error] ${toolErr.message}`);
        }

        // Update memory tracking
        if (recovered.name === 'search_workspace')
          memoryData.searchQueries.push(recovered.args.query);
        if (recovered.name === 'read_file' && !result?.error &&
            !memoryData.filesRead.includes(recovered.args.file_path))
          memoryData.filesRead.push(recovered.args.file_path);
        if (recovered.name === 'generate_prompt') {
          memoryData.rootCause    = recovered.args.root_cause;
          memoryData.fixApproach  = recovered.args.fix_approach;
          memoryData.relevantFiles = recovered.args.relevant_files ?? [];
          finalPrompt = result;
        }

        const preview = JSON.stringify(result).slice(0, 300);
        console.error(`[OBSERVE xml-recovery] ${preview}${preview.length === 300 ? '…' : ''}`);

        if (finalPrompt !== null) break;

        messages.push({
          role: 'user',
          content:
            `FORMAT ERROR (attempt ${xmlFormatRetries}): You used <function=name {}> syntax which is INVALID.\n` +
            `The "${recovered.name}" call was recovered and executed. Result:\n` +
            `${JSON.stringify(result).slice(0, 400)}\n\n` +
            'CRITICAL: NEVER use <function=...> or any text/XML format. ' +
            'Use ONLY the API structured tool_calls mechanism. Continue your investigation.',
        });

        iteration--; // don't count recovery as a real iteration
        continue;
      }

      // ── No recovery possible — nudge only ──────────────────────────────
      console.error(
        `[Loop] ⚠ XML-format tool call, failed_generation not parseable (attempt ${xmlFormatRetries}) — injecting corrective message.`
      );
      messages.push({
        role: 'user',
        content:
          'CRITICAL ERROR: You used an XML-style function call ' +
          '(<function=tool_name {"arg":"value"}></function>) which caused a 400 API error. ' +
          'You MUST use the API structured tool_calls mechanism — NEVER write function calls as text or XML. ' +
          'Retry your last intended action using a proper tool call now.',
      });
      iteration--; // don't burn an iteration on this retry
      continue;
    }

    const message = response.choices[0].message;

    // ── Parse and structurally enforce ReAct sections ─────────────────────
    const sections = parseReActSections(message.content);
    const missingThink = logReActSections(sections, !!(message.tool_calls?.length), iteration);

    messages.push(message);

    // ── Inject corrective nudge when THINK was skipped before a tool call ──
    if (missingThink) {
      messages.push({
        role: 'user',
        content:
          'PROTOCOL VIOLATION: You called a tool without first writing "THINK: <your reasoning>". ' +
          'Before every tool call you MUST output a THINK section. ' +
          'Continue your investigation and include THINK before the next tool call.',
      });
    }

    // ── No tool calls → model wrote text instead of calling a function ─────
    if (!message.tool_calls || message.tool_calls.length === 0) {
      // Try to recover: model may have emitted a JSON-text tool call.
      const textCalls = parseTextToolCalls(message.content ?? '');
      if (textCalls.length > 0) {
        console.error(
          `[Loop] ⚠ Text-format tool call detected — executing ${textCalls.length} call(s) and injecting corrective message.`
        );
        // Execute the recovered calls as if they came from tool_calls.
        const toolResults = [];
        for (const { name, args } of textCalls) {
          console.error(`\n[ACT text-fallback]  ${name}  args=${JSON.stringify(args)}`);
          let result;
          try {
            result = await executeTool(name, args, workspaceRoot);
          } catch (err) {
            result = { error: err.message };
            console.error(`[Error] ${err.message}`);
          }
          if (name === 'search_workspace') memoryData.searchQueries.push(args.query);
          if (name === 'read_file' && !result?.error && !memoryData.filesRead.includes(args.file_path))
            memoryData.filesRead.push(args.file_path);
          if (name === 'generate_prompt') {
            memoryData.rootCause    = args.root_cause;
            memoryData.fixApproach  = args.fix_approach;
            memoryData.relevantFiles = args.relevant_files ?? [];
            finalPrompt = result;
          }
          const preview = JSON.stringify(result).slice(0, 300);
          console.error(`[OBSERVE text-fallback] ${preview}${preview.length === 300 ? '…' : ''}`);
          toolResults.push({ name, result });
          if (finalPrompt !== null) break;
        }
        if (finalPrompt !== null) break;
        // Inject tool results as context then remind the model to use structured calls.
        const resultSummary = toolResults
          .map(({ name, result }) => `${name}: ${JSON.stringify(result).slice(0, 200)}`)
          .join('\n');
        messages.push({
          role: 'user',
          content:
            'CRITICAL FORMAT ERROR: You emitted tool calls as raw JSON text instead of ' +
            'using the API structured tool_calls mechanism. This is invalid. ' +
            'NEVER output {"type":"function",...}, <function=...>, or any other text-format call. ' +
            'Always invoke tools through the API tool_calls interface.\n\n' +
            'The text-format calls were recovered and executed. Results:\n' +
            resultSummary + '\n\nContinue your investigation using proper tool calls.',
        });
        continue;
      }

      // Count how many times the model has stalled (text-only response, no recoverable calls)
      const stalls = messages.filter(
        (m) => m.role === 'assistant' && (!m.tool_calls || m.tool_calls.length === 0)
      ).length;

      if (stalls <= 2) {
        console.error(`[Loop] Stall #${stalls} — nudging model to call real functions.`);
        messages.push({
          role: 'user',
          content:
            'You wrote reasoning text but did not invoke any tool function. ' +
            'You MUST call tools using the API structured tool_calls mechanism — ' +
            'do NOT write tool calls as plain text, JSON, or XML. ' +
            'Continue your investigation and invoke the next tool now.',
        });
        continue; // re-enter the while loop without incrementing
      }

      console.error('[Loop] Model stalled after 2 nudges — returning text as-is.');
      finalPrompt = message.content ?? '(agent returned empty response)';
      break;
    }

    // ── Execute each requested tool ───────────────────────────────────────
    for (const toolCall of message.tool_calls) {
      const name = toolCall.function.name;
      let args;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      console.error(`\n[ACT]  ${name}  args=${JSON.stringify(args)}`);

      let result;
      try {
        result = await executeTool(name, args, workspaceRoot);
      } catch (err) {
        result = { error: err.message };
        console.error(`[Error] ${err.message}`);
      }

      // ── Update cross-run memory data ────────────────────────────────────
      if (name === 'fetch_jira_ticket' && !result?.error) {
        memoryData.ticketSummary = result.title ?? memoryData.ticketSummary;
      }
      if (name === 'search_workspace') {
        memoryData.searchQueries.push(args.query);
      }
      if (name === 'read_file' && !result?.error) {
        if (!memoryData.filesRead.includes(args.file_path)) {
          memoryData.filesRead.push(args.file_path);
        }
      }
      if (name === 'generate_prompt') {
        memoryData.rootCause    = args.root_cause;
        memoryData.fixApproach  = args.fix_approach;
        memoryData.relevantFiles = args.relevant_files ?? [];

        // ── Confidence check: did the agent actually read application code? ──
        const appFilesRead = memoryData.filesRead.filter(
          (f) => !PROMPTPILOT_OWN_FILES.has(f)
        );
        const appFilesListed = (args.relevant_files ?? []).filter(
          (f) => !PROMPTPILOT_OWN_FILES.has(f)
        );

        if (appFilesRead.length === 0 || appFilesListed.length === 0) {
          console.error(
            '[⚠ Confidence] No application code read — output marked LOW CONFIDENCE.'
          );
          finalPrompt =
            '> ⚠️  **LOW CONFIDENCE** — The agent could not locate application source files ' +
            'in this workspace. The root cause and file references below are **unverified**. ' +
            'Re-run PromptPilot with the workspace root pointing at the target application repository.\n\n' +
            result;
        } else {
          finalPrompt = result;
        }
      }

      const preview = JSON.stringify(result).slice(0, 300);
      console.error(`[OBSERVE] ${preview}${preview.length === 300 ? '…' : ''}`);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });

      if (finalPrompt !== null) break;
    }
  }

  // ── Fallback if max iterations exhausted ─────────────────────────────────
  if (finalPrompt === null) {
    console.error('[Loop] Max iterations reached — returning fallback message.');
    finalPrompt =
      `⚠️  Agent reached the iteration limit while investigating ${ticketId}. ` +
      'Please review the ticket and relevant files manually.';
  }

  // ── Phase 7: Save to cross-run memory ────────────────────────────────────
  if (memoryData.rootCause) {
    saveTicketMemory(ticketId, memoryData, workspaceRoot);
  }

  console.error(`\n${'═'.repeat(60)}`);
  console.error('[PromptPilot] DONE');
  console.error(`${'═'.repeat(60)}\n`);

  return typeof finalPrompt === 'string' ? finalPrompt : JSON.stringify(finalPrompt, null, 2);
}
