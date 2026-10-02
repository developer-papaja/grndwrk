import type { NodeType } from '../../src/shared/types'

/** Calm colors that stay readable on the dark background. */
export const TYPE_COLORS: Record<NodeType, string> = {
  idea: '#d9d3b8',
  audience: '#e2a982',
  flow: '#8fc4a8',
  feature: '#8db4dc',
  content: '#c4a6dc',
  design: '#e29db2',
  constraint: '#b3aaa2',
  question: '#efc56d',
  decision: '#79cfc4',
  reference: '#9ba6b9',
}

export const SCENE_COLORS = {
  background: '#0e1116',
  error: '#d0796b',
  label: '#dfe3ea',
  link: '#a0aab9',
  guide: '#2a313c',
  guideText: 'rgba(223, 227, 234, 0.28)',
  topic: 'rgba(223, 227, 234, 0.4)',
}
