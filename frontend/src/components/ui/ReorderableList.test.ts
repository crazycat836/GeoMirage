import { describe, it, expect } from 'vitest'
import type { Active, Over } from '@dnd-kit/core'
import { buildDragA11y } from './ReorderableList'
import { translate } from '../../i18n'
import type { StringKey } from '../../i18n'

const NAMES: Record<string, string> = { 'wp-3': '台北車站', 'wp-4': '西門町' }
const getLabel = (id: string) => NAMES[id] ?? '?'
const tZh = (k: StringKey, v?: Record<string, string | number>) => translate('zh', k, v)

const active = { id: 'wp-3' } as unknown as Active
const over = { id: 'wp-4' } as unknown as Over

describe('buildDragA11y', () => {
  const { announcements, screenReaderInstructions } = buildDragA11y(tZh, getLabel)

  it('announces item names in the current language, never row ids', () => {
    const spoken = [
      announcements.onDragStart({ active }),
      announcements.onDragOver({ active, over }),
      announcements.onDragOver({ active, over: null }),
      announcements.onDragEnd({ active, over }),
      announcements.onDragEnd({ active, over: null }),
      announcements.onDragCancel({ active, over: null }),
    ]
    for (const line of spoken) {
      expect(line).toContain('台北車站')
      expect(line).not.toMatch(/wp-\d/)
      expect(line).not.toMatch(/[A-Za-z]{3,}/)
    }
    expect(announcements.onDragOver({ active, over })).toContain('西門町')
  })

  it('localises the keyboard instructions', () => {
    expect(screenReaderInstructions.draggable).toBe(translate('zh', 'dnd.instructions'))
  })
})
