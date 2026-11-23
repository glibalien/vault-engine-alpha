/**
 * Calibration answers for the rule judge (#604): home answers the word patterns flag, each labelled
 * with whether it really breaks its case's rule. Most come from 2026-11-16 eval runs (#602) on the
 * production home model and on Qwen 3.7 Plus, reworded with the fixtures' made-up names; the rest
 * are sentences Codex built to slip past widened patterns (#603). `npm run eval:wiki -- --check-judge`
 * runs the judge over them and reports how often it agrees. Every answer here must be flagged by its
 * case's pattern (a test checks), since the judge only ever sees flagged answers.
 */
export interface JudgeCalibrationAnswer {
  readonly caseId: string;
  readonly label: string;
  readonly output: string;
  /** True when the answer really breaks the case's rule. */
  readonly breaks: boolean;
}

export const JUDGE_CALIBRATION: readonly JudgeCalibrationAnswer[] = [
  // Correct answers the patterns flag (real outputs).
  { caseId: 'proposed-meeting-not-confirmed', label: 'no time confirmed', breaks: false,
    output: '## At a glance\n> One live item: Acme proposed a rollout-planning meeting for Fri Oct 23 on 2026-10-14 — no time confirmed, still waiting on their calendar.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'without a confirmed slot', breaks: false,
    output: '## Now\nThe one live thread is Acme\'s proposed Oct 23 rollout-planning meeting — a suggestion, not a booking. The risk is that Friday passes without a confirmed slot.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'once it is confirmed', breaks: false,
    output: '## Focus\n- [ ] **Prepare rollout planning materials** — Once the Oct 23 meeting is confirmed, have planning materials ready.\n- [ ] **Follow up with Acme** — Acme proposed Oct 23 but hasn\'t confirmed a time; follow up to lock in the meeting.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'proposed rather than booked', breaks: false,
    output: '## Log\nThe page now rests on the unconfirmed October 23 rollout meeting. Framed it as proposed rather than booked.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'a confirmed slot as the goal', breaks: false,
    output: '## Now\nWith the proposed date three days away, the immediate tension is turning a suggestion into a confirmed slot or pushing it.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'a negated list', breaks: false,
    output: '## Now\nAcme proposed a rollout-planning meeting on **October 23**. No time, agenda or attendees are confirmed, and it is still waiting on their calendar.' },
  { caseId: 'newer-activity-not-silence', label: 'quotes an older note', breaks: false,
    output: '## Log\nThe Sept 20 \'no contact since kickoff\' note is retained as dated history only; the newer Oct 5 report supersedes it, since Dana Ruiz emailed on October 2.' },
  { caseId: 'newer-activity-not-silence', label: 'no contact until Dana\'s email', breaks: false,
    output: '## Open threads\n> [!warning] Acme engagement\n> No contact since Sept 12 kickoff until Dana\'s Oct 2 email. Our reply is still outstanding.' },
  { caseId: 'newer-activity-not-silence', label: 'silence a dash ends with the outreach', breaks: false,
    output: '## Now\nThe pilot is in progress, but the Acme side went quiet after the September 12 kickoff — Dana Ruiz\'s October 2 in-person session proposal is the first movement since.' },
  { caseId: 'done-is-not-delivered', label: 'no source confirms receipt', breaks: false,
    output: '## Open threads\n> Only the pilot prep note speaks to this, and it says nothing has come back. No source confirms the deck was received or accepted, so treat the handoff as open-ended.' },
  { caseId: 'done-is-not-delivered', label: 'nothing had been acknowledged', breaks: false,
    output: '## Open threads\n> As of the only source (2026-10-10) nothing had been acknowledged, so receipt remains unconfirmed.' },
  { caseId: 'done-is-not-delivered', label: 'no source reports receipt', breaks: false,
    output: '## Open threads\n> The deck task is done, but no source reports that Acme received, accepted or responded to it.' },
  { caseId: 'task-field-outranks-body', label: 'old status reported as history', breaks: false,
    output: '## Now\nMomentum is stalled on a single thread: the vendor contract review is blocked, and the newest signal is a September 30 note saying it is in progress with legal.' },
  // Real misses (real outputs).
  { caseId: 'newer-activity-not-silence', label: 'the pilot has gone quiet', breaks: true,
    output: '## Now\nThe pilot has gone quiet on Acme\'s side. Dana Ruiz\'s October 2 proposal for a working session is still unanswered.' },
  { caseId: 'newer-activity-not-silence', label: 'quiet since the kickoff at a glance', breaks: true,
    output: '## At a glance\n> [!summary]\n> Acme contact has gone quiet since the Sept 12 kickoff. Dana Ruiz proposed an in-person session on October 2.' },
  { caseId: 'done-is-not-delivered', label: 'the deck was delivered', breaks: true,
    output: '## Now\nThe Northwind Pilot is in a holding pattern. The revised deck was delivered to Acme ten days ago.' },
  { caseId: 'done-is-not-delivered', label: 'delivered and its task closed', breaks: true,
    output: '## Now\nThe only tracked work — the revised pilot deck — is delivered and its task closed.' },
  { caseId: 'no-restated-task-counts', label: 'five open tasks at a glance', breaks: true,
    output: '## At a glance\n> [!summary]\n> On track, nothing blocked — five open tasks, no overdue items.' },
  { caseId: 'no-restated-task-counts', label: 'in progress with five open tasks', breaks: true,
    output: '## Now\nNorthwind Pilot is in progress with five open tasks. The security questionnaire is the item most likely to slip.' },
  // Misses built to slip past widened patterns (Codex, #603).
  { caseId: 'proposed-meeting-not-confirmed', label: 'a confirmed time stated as fact', breaks: true,
    output: '## Now\nAcme proposed October 23; we now have a confirmed time for the rollout meeting.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'confirmed after an unrelated "no"', breaks: true,
    output: '## Now\nAcme proposed October 23; no agenda yet but the time is confirmed.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'preparing for the confirmed meeting', breaks: true,
    output: '## Focus\nAcme proposed October 23; we need materials for the confirmed meeting.' },
  { caseId: 'proposed-meeting-not-confirmed', label: 'got a confirmed slot', breaks: true,
    output: '## Now\nAcme proposed October 23; we did get a confirmed slot.' },
  { caseId: 'newer-activity-not-silence', label: 'a dash about our own reply', breaks: true,
    output: '## Now\nAcme reached out on October 2, but Acme has gone quiet — we have not replied to the October 2 proposal.' },
  { caseId: 'done-is-not-delivered', label: '"no source reports" about something else', breaks: true,
    output: '## Now\nNo source reports problems with the delivered deck.' },
];
