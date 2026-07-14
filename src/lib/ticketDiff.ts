import type { Ticket } from '../../shared/constants.js';

export type TicketFormFields = Pick<Ticket,
  'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>

// Order-sensitive, but a reorder isn't a change worth PATCHing — content is what matters.
function blockersEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Return ONLY fields differing from the open-time baseline, so a save PATCHes just what the user changed — an unchanged field can't clobber a concurrent external edit (e.g. an agent moving status behind the modal). Full optimistic locking is separate (tkt-2597a4525562).
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
