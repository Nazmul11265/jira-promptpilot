/**
 * Quick CLI test — runs the ReAct agent against any Jira ticket ID.
 * Usage:  node test-agent.js PROJ-123
 *         node test-agent.js          (uses mock ticket)
 */
import 'dotenv/config';
import { runAgent } from './src/agent.js';

const ticketId    = process.argv[2] ?? 'P1794-226';
const workspaceRoot = process.argv[3] ?? process.cwd();

console.log(`\nTesting agent with ticket: ${ticketId}`);
console.log(`Workspace root: ${workspaceRoot}\n`);

try {
  const result = await runAgent(ticketId, workspaceRoot);
  console.log('\n' + '═'.repeat(60));
  console.log('FINAL COPILOT PROMPT:');
  console.log('═'.repeat(60));
  console.log(result);
} catch (err) {
  console.error('Test failed:', err.message);
  process.exit(1);
}
