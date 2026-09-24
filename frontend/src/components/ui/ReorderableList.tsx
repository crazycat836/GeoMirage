import { useMemo, type ReactNode } from 'react'
import {
  DndContext,
  closestCenter,
  type Announcements,
  type DragEndEvent,
  type ScreenReaderInstructions,
  type SensorDescriptor,
  type SensorOptions,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useT } from '../../i18n'

type Translate = ReturnType<typeof useT>

interface ReorderableListProps {
  sensors: SensorDescriptor<SensorOptions>[]
  onDragEnd: (event: DragEndEvent) => void
  /** Sorted row ids, in render order. */
  items: string[]
  /** Human-readable name for a row id, spoken by screen readers during a
   *  keyboard drag (dnd-kit's default would read the raw id). */
  getLabel: (id: string) => string
  children: ReactNode
}

/** Localised dnd-kit screen-reader copy that names rows via `getLabel`. */
export function buildDragA11y(
  t: Translate,
  getLabel: (id: string) => string,
): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
  const name = (id: UniqueIdentifier) => getLabel(String(id))
  return {
    screenReaderInstructions: { draggable: t('dnd.instructions') },
    announcements: {
      onDragStart: ({ active }) => t('dnd.picked_up', { item: name(active.id) }),
      onDragOver: ({ active, over }) =>
        over
          ? t('dnd.over', { item: name(active.id), over: name(over.id) })
          : t('dnd.not_over', { item: name(active.id) }),
      onDragEnd: ({ active, over }) =>
        over
          ? t('dnd.dropped_over', { item: name(active.id), over: name(over.id) })
          : t('dnd.dropped', { item: name(active.id) }),
      onDragCancel: ({ active }) => t('dnd.cancelled', { item: name(active.id) }),
    },
  }
}

// Shared DndContext + SortableContext scaffold for every sortable list in
// the app. Keeps the collision/strategy policy (closestCenter + vertical
// list) and the screen-reader copy defined once; sensors/onDragEnd come
// from useDragReorder.
export default function ReorderableList({ sensors, onDragEnd, items, getLabel, children }: ReorderableListProps) {
  const t = useT()
  const accessibility = useMemo(() => buildDragA11y(t, getLabel), [t, getLabel])
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={accessibility}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}
