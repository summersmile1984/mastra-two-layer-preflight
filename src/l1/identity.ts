/**
 * Mastra multi-user-threads helpers.
 * Official docs: https://mastra.ai/docs/memory/multi-user-threads
 * Speaker identity must be set server-side from auth + room_members.role (never from request body).
 */
export type Speaker = { id: string; name: string; role: string };

/** Escape attribute values for <turn …> tags. */
export function escapeAttr(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape message body so a user cannot close the turn tag early. */
function escapeBody(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wrap a human (or system) utterance in the official <turn> tag.
 * Primary attrs: author_id, author_name, functional_role.
 * Optional extras (e.g. room=, via=) for product context only.
 */
export function asUserTurn(
  speaker: Speaker,
  text: string,
  extra?: Record<string, string>,
): { role: 'user'; content: string } {
  const attrs = [
    `author_id="${escapeAttr(speaker.id)}"`,
    `author_name="${escapeAttr(speaker.name)}"`,
    `functional_role="${escapeAttr(speaker.role)}"`,
  ];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v == null || v === '') continue;
      // refuse reserved primary keys being overridden via extra
      if (k === 'author_id' || k === 'author_name' || k === 'functional_role') continue;
      attrs.push(`${k}="${escapeAttr(v)}"`);
    }
  }
  return {
    role: 'user',
    content: `<turn ${attrs.join(' ')}>
${escapeBody(text)}
</turn>`,
  };
}

/**
 * Mastra-style working-memory participants template for shared room threads.
 * D1 / Cloudflare D1Store does not support Observational Memory; docs recommend
 * a structured participants list in working memory when OM is unavailable.
 */
export function participantsWorkingMemory(
  members: { name: string; id: string; role: string }[],
): string {
  const lines = members.map((m) => {
    const name = (m.name || m.id || 'unknown').trim();
    return `- **${name}** (${m.id}, ${m.role})`;
  });
  return `# Room Collaboration State

## Participants
<!-- One entry per known collaborator. Use author_id as the stable key. Server refreshes on each room message (D1 has no Observational Memory). -->
${lines.length ? lines.join('\n') : '<!-- (no members yet) -->'}

## Open Questions

## Decisions
`;
}
