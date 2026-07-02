import type { Ticket } from '../../shared/constants.js';

// The user-editable subset of a ticket that the modal form owns.
export type TicketFormFields = Pick<Ticket,
  'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>

// Order-sensitive blocker equality (order carries no meaning today, but a
// reorder is still not a "change" worth PATCHing — content is what matters).
function blockersEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Return ONLY the fields whose value differs from the open-time baseline, so a
// modal save PATCHes exactly what the user changed. An unchanged field is then
// omitted and can't clobber a concurrent external edit — e.g. the agent moving a
// ticket in-progress→qa behind an open modal is preserved when the user only
// fixes a title typo. (Full optimistic locking is a separate concern — see
// tkt-2597a4525562; this just removes the everyday collision.)
export function changedFormFields(
  form: TicketFormFields,
  baseline: TicketFormFields,
): Partial<TicketFormFields> {
  return {
    ...(form.title !== baseline.title ? { title: form.title } : {}),
    ...(form.type !== baseline.type ? { type: form.type } : {}),
    ...(form.priority !== baseline.priority ? { priority: form.priority } : {}),
    ...(form.status !== baseline.status ? { status: form.status } : {}),
    ...(form.body !== baseline.body ? { body: form.body } : {}),
    ...(form.project !== baseline.project ? { project: form.project } : {}),
    ...(form.parent !== baseline.parent ? { parent: form.parent } : {}),
    ...(form.dueDate !== baseline.dueDate ? { dueDate: form.dueDate } : {}),
    ...(form.assignee !== baseline.assignee ? { assignee: form.assignee } : {}),
    ...(blockersEqual(form.blockers, baseline.blockers) ? {} : { blockers: form.blockers }),
  };
}
