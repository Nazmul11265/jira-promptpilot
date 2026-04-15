/**
 * Prompt Generator
 * ────────────────
 * Formats the agent's findings into a structured VS Code Copilot prompt
 * that is ready to paste (or stream) into the chat or inline chat.
 */

/**
 * @param {object} params
 * @param {string}   params.ticket_summary
 * @param {string}  [params.issue_type]
 * @param {string}   params.root_cause
 * @param {string[]} [params.relevant_files]
 * @param {string}  [params.code_context]
 * @param {string}   params.fix_approach
 * @param {string}  [params.acceptance_criteria]
 * @returns {string}  Formatted Copilot prompt
 */
export function generateCopilotPrompt({
  ticket_summary,
  issue_type = 'Bug',
  root_cause,
  relevant_files,
  code_context,
  fix_approach,
  acceptance_criteria,
}) {
  const filesSection =
    relevant_files?.length
      ? `\n## Files to Modify\n${relevant_files.map((f) => `- \`${f}\``).join('\n')}\n`
      : '';

  const codeBlock = code_context
    ? `\n## Problematic Code\n\`\`\`\n${code_context.trim()}\n\`\`\`\n`
    : '';

  const criteria = acceptance_criteria
    ? `\n## Acceptance Criteria\n${acceptance_criteria.trim()}\n`
    : '';

  return `\
# ${issue_type}: ${ticket_summary}

## Root Cause
${root_cause.trim()}
${filesSection}${codeBlock}
## Proposed Fix
${fix_approach.trim()}
${criteria}
---

Please implement the fix described above. Make sure the solution:
1. Addresses the root cause precisely — not just the symptoms.
2. Preserves full backward compatibility.
3. Follows the existing code style, naming conventions, and patterns of the modified files.
4. Does not introduce regressions in related functionality.
5. Includes any necessary tests that verify the fix.
`;
}
