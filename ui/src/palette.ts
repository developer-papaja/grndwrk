import type { NodeType } from '../../src/shared/types'

/** Calm colors that stay readable on the background; each theme's values are in style.css. */
export const TYPE_COLORS: Record<NodeType, string> = {
  idea: 'var(--type-idea)',
  audience: 'var(--type-audience)',
  flow: 'var(--type-flow)',
  feature: 'var(--type-feature)',
  content: 'var(--type-content)',
  design: 'var(--type-design)',
  constraint: 'var(--type-constraint)',
  question: 'var(--type-question)',
  decision: 'var(--type-decision)',
  reference: 'var(--type-reference)',
}
