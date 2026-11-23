import { checkListLimit, ReferenceEditError, type MemberPlan, type MemberPlanInput } from './types.js';

export function planReferenceEdit({ edit, before, identity }: MemberPlanInput): MemberPlan {
  checkListLimit(before.values);
  const matching = before.values.map(value => {
    if ('stored_value' in edit.target) return value === edit.target.stored_value;
    const candidates = identity.candidates(value);
    const targetId = edit.target.node_id;
    const includesTarget = candidates.some(n => n.id === targetId);
    if (includesTarget && candidates.length > 1) {
      throw new ReferenceEditError('AMBIGUOUS_MATCH', 'Stored reference has an ambiguous target', { reason: 'ambiguous_member' });
    }
    return includesTarget;
  });
  const matches = matching.filter(Boolean).length;
  const changed = edit.action === 'add' ? matches === 0 : matches > 0;
  let values = before.values;
  if (changed) {
    if (edit.action === 'remove') values = before.values.filter((_, i) => !matching[i]);
    else {
      if (!('node_id' in edit.target)) throw new ReferenceEditError('INVALID_PARAMS', 'Add requires a target node ID', { reason: 'add_selector' });
      values = [...before.values, identity.additionTitle(edit.target.node_id)];
    }
  }
  checkListLimit(values);
  return {
    changed, values,
    outcome: edit.action === 'add' ? changed ? 'added' : 'already_present' : changed ? 'removed' : 'already_absent',
    before: { presence: before.presence, count: before.values.length },
    after: { presence: changed ? 'list' : before.presence, count: values.length },
    added_count: changed && edit.action === 'add' ? 1 : 0,
    removed_count: changed && edit.action === 'remove' ? matches : 0,
  };
}
