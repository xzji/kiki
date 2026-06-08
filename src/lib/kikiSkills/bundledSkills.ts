import type { BundledKikiSkill } from "./types";

export const BUNDLED_KIKI_SKILLS: BundledKikiSkill[] = [
  {
    id: "example-helper",
    targetName: "kiki-example-helper",
    version: "0.1.0",
    files: [
      {
        relativePath: "SKILL.md",
        content: `# KiKi Example Helper

This is a minimal KiKi bundled skill used to verify the manual installation flow.

Use this skill when the user asks whether KiKi default skills are installed correctly.

## Instructions

- State that this skill is a KiKi-managed example skill.
- Keep the response short.
- Do not claim it provides production behavior.
`,
      },
    ],
  },
  {
    id: "task-spec-helper",
    targetName: "kiki-task-spec-helper",
    version: "0.1.0",
    files: [
      {
        relativePath: "SKILL.md",
        content: `# KiKi Task Spec Helper

Use this skill when drafting or reviewing task specifications for KiKi-managed work.

## Instructions

- Identify the task goal, success criteria, constraints, and out-of-scope items.
- Prefer a single source of truth for execution state and user-visible status.
- Call out ambiguous requirements before implementation starts.
- Keep the final spec actionable for an executor.
`,
      },
    ],
  },
];
