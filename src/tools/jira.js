/**
 * Jira Tool
 * ─────────
 * Fetches a Jira ticket via the REST API v3.
 * Falls back to mock data when credentials are not configured (for local dev/testing).
 */

// ─── Atlassian Document Format (ADF) → plain text ────────────────────────────

function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (Array.isArray(node.content)) {
    const text = node.content.map(adfToText).join('');
    // Add paragraph breaks
    if (node.type === 'paragraph') return text + '\n';
    if (node.type === 'listItem') return `• ${text}`;
    return text;
  }
  return '';
}

function extractText(field) {
  if (!field) return '';
  if (typeof field === 'string') return field;
  // ADF document
  if (field.type === 'doc') return adfToText(field).trim();
  return JSON.stringify(field);
}

function extractComments(commentField) {
  if (!commentField?.comments?.length) return [];
  return commentField.comments
    .slice(-5) // most recent 5
    .map((c) => ({
      author: c.author?.displayName ?? 'Unknown',
      body: extractText(c.body),
      created: c.created,
    }));
}

// ─── Live Jira fetch ──────────────────────────────────────────────────────────

export async function fetchJiraTicket(ticketId) {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.error('[Jira] Credentials not set — using mock ticket data.');
    return getMockTicket(ticketId);
  }

  const url = new URL(`/rest/api/3/issue/${encodeURIComponent(ticketId)}`, JIRA_BASE_URL);
  const credentials = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Jira API returned ${response.status} ${response.statusText}: ${body.slice(0, 200)}`
    );
  }

  const data = await response.json();
  const f = data.fields;

  return {
    id: data.key,
    title: f.summary,
    type: f.issuetype?.name ?? 'Unknown',
    status: f.status?.name ?? 'Unknown',
    priority: f.priority?.name ?? 'Unknown',
    description: extractText(f.description),
    assignee: f.assignee?.displayName ?? 'Unassigned',
    reporter: f.reporter?.displayName ?? 'Unknown',
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c) => c.name),
    comments: extractComments(f.comment),
    created: f.created,
    updated: f.updated,
  };
}

// ─── Mock data (used when Jira is not configured) ─────────────────────────────

function getMockTicket(ticketId) {
  return {
    id: ticketId,
    title: '[MOCK] Login button unresponsive on mobile devices',
    type: 'Bug',
    status: 'In Progress',
    priority: 'High',
    description:
      'The login button on the mobile web app does not respond to taps. ' +
      'Users report that clicking the login button has no effect on iOS Safari and Android Chrome. ' +
      'The button renders correctly and there are no console errors, but the onClick handler ' +
      'does not fire on touch devices. Desktop browsers work fine.',
    assignee: 'Dev Team',
    reporter: 'QA Team',
    labels: ['mobile', 'auth', 'critical'],
    components: ['Authentication', 'Mobile'],
    comments: [
      {
        author: 'QA Engineer',
        body: 'Confirmed on iPhone 13 (iOS 17) and Samsung Galaxy S21 (Android 14). Desktop Chrome/Firefox/Safari work as expected.',
        created: new Date().toISOString(),
      },
      {
        author: 'Product Manager',
        body: 'This is blocking ~40% of our users. Needs urgent fix.',
        created: new Date().toISOString(),
      },
    ],
    created: new Date(Date.now() - 86_400_000).toISOString(),
    updated: new Date().toISOString(),
  };
}
