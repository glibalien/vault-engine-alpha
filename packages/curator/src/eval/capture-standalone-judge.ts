import type { JsonSchema, LlmClient } from '../llm/types.js';

export interface CaptureEvalExactArtifact {
  artifactKey: string;
  title: string;
  markdown: string;
  sourceUrls: string[];
}

export type CaptureStandaloneAssessment =
  | 'standalone-useful'
  | 'needs-context'
  | 'not-useful';

export interface CaptureStandaloneArtifactJudgment {
  artifactKey: string;
  assessment: CaptureStandaloneAssessment;
  rationale: string;
}

export interface CaptureStandaloneUsefulness {
  source: 'offline-deterministic' | 'live-model';
  assessment: CaptureStandaloneAssessment | 'not-applicable' | 'unavailable';
  artifactJudgments: CaptureStandaloneArtifactJudgment[];
  rationale: string;
}

export const CAPTURE_STANDALONE_JUDGE_FAILURE_REASON = 'standalone_judge_failed';
export const MAX_CAPTURE_STANDALONE_JUDGE_PROVIDER_PROMPT_CHARS = 80_000;

export const CAPTURE_STANDALONE_JUDGE_SYSTEM_PROMPT = `You are an evaluation-only judge of conversation-capture artifacts.

Read only the exact artifact titles and Markdown supplied. Decide whether each artifact is concise, useful, and understandable by a future reader who cannot see the originating conversation. Do not reward transcript-dependent references such as “this”, “that approach”, or unexplained actors. Do not fact-check claims or invent missing context.

Return one judgment for every supplied artifact key:
- standalone-useful: self-contained and usefully preserves durable value.
- needs-context: potentially useful, but material meaning depends on missing conversation context.
- not-useful: empty, incoherent, redundant, or not meaningfully useful as a durable note.

This is qualitative review evidence only; it is not a numeric release gate.`;

export const CAPTURE_STANDALONE_JUDGE_TOOL: {
  name: string;
  description: string;
  schema: JsonSchema;
} = {
  name: 'judge_capture_standalone_usefulness',
  description: 'Qualitatively assess the standalone usefulness of every exact capture artifact.',
  schema: {
    type: 'object',
    properties: {
      artifact_judgments: {
        type: 'array',
        description: 'Exactly one qualitative judgment for every supplied artifact key.',
        items: {
          type: 'object',
          properties: {
            artifact_key: { type: 'string' },
            assessment: {
              type: 'string',
              enum: ['standalone-useful', 'needs-context', 'not-useful'],
            },
            rationale: { type: 'string' },
          },
          required: ['artifact_key', 'assessment', 'rationale'],
        },
      },
    },
    required: ['artifact_judgments'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function overallAssessment(
  judgments: readonly CaptureStandaloneArtifactJudgment[],
): CaptureStandaloneAssessment {
  if (judgments.some((judgment) => judgment.assessment === 'not-useful')) return 'not-useful';
  if (judgments.some((judgment) => judgment.assessment === 'needs-context')) return 'needs-context';
  return 'standalone-useful';
}

export function parseCaptureStandaloneJudgments(
  output: unknown,
  artifacts: readonly CaptureEvalExactArtifact[],
): CaptureStandaloneArtifactJudgment[] {
  if (!isRecord(output) || !Array.isArray(output.artifact_judgments)) {
    throw new Error('standalone judge output must contain artifact_judgments');
  }
  const byKey = new Map<string, CaptureStandaloneArtifactJudgment>();
  for (const [index, value] of output.artifact_judgments.entries()) {
    if (!isRecord(value)) throw new Error(`standalone judge artifact_judgments[${index}] must be an object`);
    const key = value.artifact_key;
    const assessment = value.assessment;
    const rationale = value.rationale;
    if (typeof key !== 'string' || key.trim() === '') {
      throw new Error(`standalone judge artifact_judgments[${index}].artifact_key must be non-empty`);
    }
    if (assessment !== 'standalone-useful' && assessment !== 'needs-context' && assessment !== 'not-useful') {
      throw new Error(`standalone judge artifact_judgments[${index}].assessment is invalid`);
    }
    if (typeof rationale !== 'string' || rationale.trim() === '') {
      throw new Error(`standalone judge artifact_judgments[${index}].rationale must be non-empty`);
    }
    if (byKey.has(key)) throw new Error(`standalone judge duplicated artifact key ${key}`);
    byKey.set(key, { artifactKey: key, assessment, rationale: rationale.trim() });
  }
  if (byKey.size !== artifacts.length) throw new Error('standalone judge did not return exactly one judgment per artifact');
  return artifacts.map((artifact) => {
    const judgment = byKey.get(artifact.artifactKey);
    if (judgment === undefined) throw new Error(`standalone judge omitted artifact key ${artifact.artifactKey}`);
    return judgment;
  });
}

export function deterministicCaptureStandaloneUsefulness(
  artifacts: readonly CaptureEvalExactArtifact[],
): CaptureStandaloneUsefulness {
  if (artifacts.length === 0) {
    return {
      source: 'offline-deterministic',
      assessment: 'not-applicable',
      artifactJudgments: [],
      rationale: 'No capture artifact was emitted.',
    };
  }
  const artifactJudgments = artifacts.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    assessment: 'standalone-useful' as const,
    rationale: 'Deterministic offline fixture composition is labelled standalone-useful.',
  }));
  return {
    source: 'offline-deterministic',
    assessment: 'standalone-useful',
    artifactJudgments,
    rationale: 'All deterministic offline fixture artifacts are labelled standalone-useful.',
  };
}

export async function judgeCaptureStandaloneUsefulness(args: {
  llm: LlmClient;
  model: string;
  maxTokens: number;
  artifacts: readonly CaptureEvalExactArtifact[];
}): Promise<CaptureStandaloneUsefulness> {
  if (args.artifacts.length === 0) {
    return {
      source: 'live-model',
      assessment: 'not-applicable',
      artifactJudgments: [],
      rationale: 'No capture artifact was emitted.',
    };
  }
  const { output } = await args.llm.structuredCall({
    model: args.model,
    maxTokens: args.maxTokens,
    system: CAPTURE_STANDALONE_JUDGE_SYSTEM_PROMPT,
    user: JSON.stringify({ artifacts: args.artifacts }),
    toolName: CAPTURE_STANDALONE_JUDGE_TOOL.name,
    toolDescription: CAPTURE_STANDALONE_JUDGE_TOOL.description,
    schema: CAPTURE_STANDALONE_JUDGE_TOOL.schema,
    malformedOutputPolicy: 'fail-closed-redacted',
    providerPromptCharCap: MAX_CAPTURE_STANDALONE_JUDGE_PROVIDER_PROMPT_CHARS,
  });
  const artifactJudgments = parseCaptureStandaloneJudgments(output, args.artifacts);
  const assessment = overallAssessment(artifactJudgments);
  return {
    source: 'live-model',
    assessment,
    artifactJudgments,
    rationale: assessment === 'standalone-useful'
      ? 'Every exact artifact was judged standalone-useful.'
      : `At least one exact artifact was judged ${assessment}.`,
  };
}

export function unavailableCaptureStandaloneUsefulness(): CaptureStandaloneUsefulness {
  return {
    source: 'live-model',
    assessment: 'unavailable',
    artifactJudgments: [],
    rationale: CAPTURE_STANDALONE_JUDGE_FAILURE_REASON,
  };
}
